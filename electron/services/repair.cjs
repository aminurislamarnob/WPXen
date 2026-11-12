'use strict';

// Self-healing 502. When nginx can't reach a Site's PHP-FPM it serves WPXen's
// error page (errorPages.cjs), which asks this module — through the Unix-socket
// server in repairServer.cjs — to repair the Site, and polls for the result.
//
// The caller only ever names a host. The host maps to a known Site and that
// Site's PHP version; nothing else (a command, a path, a version) is taken
// from the request.

const brew = require('./brew.cjs');
const php = require('./php.cjs');
const repairServer = require('./repairServer.cjs');

// Names that carry the app's name outside its bundle (see CLAUDE.md, "Legacy
// names") — a future rename has to find and migrate these.
const REPAIR_SOCKET_NAME = 'wpxen-repair.sock';
// The URL prefix the shared nginx snippet reserves on every Site.
const RESERVED_PREFIX = '/__wpxen/';

// macOS sun_path is 104 bytes including the terminating NUL.
const MAX_SOCKET_PATH_BYTES = 103;

// Beside the FPM sockets, under the Homebrew prefix — not in userData:
// "Application Support" has a space, which nginx's `unix:` upstream syntax
// can't take.
function repairSocketPath(prefix = brew.getBrewPrefix()) {
  if (!prefix) return null;
  const p = `${prefix}/var/run/${php.FPM_RUN_DIR}/${REPAIR_SOCKET_NAME}`;
  if (Buffer.byteLength(p) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`Repair socket path is too long for a Unix socket: ${p}`);
  }
  return p;
}

// The app's own limit, per Site and independent of the page's per-tab one: a
// hostile page (any site can fire a no-cors POST at shop.test) or several
// open tabs can't keep PHP restarting. Only repairs that actually restart
// count — a request that joins one already running costs nothing.
const MAX_REPAIRS_PER_SITE = 3;
const REPAIR_WINDOW_MS = 60_000;

// The Site a request's host names, with the PHP version it runs on. Only the
// Site's own domain and its subdomains count: a share-tunnel alias is a public
// hostname, and visitors arriving through it mustn't be able to restart PHP.
// Subdomains are matched the way nginx routes them to the vhost's `*.domain`
// (nginx.cjs) — an exact Site first, then the longest parent domain — so the
// 502 page on `en.shop.test` repairs shop.test, under shop.test's limit. Pure.
function siteForHost(sites, host, activeVersion) {
  const name = String(host || '')
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
  if (!name) return null;
  let site = null;
  for (const s of sites || []) {
    if (!s || !s.domain) continue;
    if (s.domain === name) {
      site = s;
      break;
    }
    if (
      name.endsWith(`.${s.domain}`) &&
      (!site || s.domain.length > site.domain.length)
    ) {
      site = s;
    }
  }
  if (!site) return null;
  // A Site with no recorded version predates per-site PHP and runs on the
  // active one (as its vhost does, nginx.cjs). Taken as a thunk too, since
  // resolving it spawns php — only worth it for such a Site.
  const phpVersion =
    site.phpVersion ||
    (typeof activeVersion === 'function' ? activeVersion() : activeVersion);
  return phpVersion ? { domain: site.domain, phpVersion } : null;
}

// The repair engine. Collaborators are injected so it runs under plain Node:
//   sites()             → the store's Sites
//   activePhpVersion()  → the version a Site with none runs on
//   restartFpm(version) → restart that one version's FPM (throws on failure)
//   fpmAccepts(version) → does its socket accept connections now
//
// status(host) / repair(host) return null for a host that is no known Site;
// otherwise { state, step, phpVersion, error } where state is idle |
// repairing | healthy | failed | limited and step names what's running.
function createRepairer({
  sites,
  activePhpVersion,
  restartFpm,
  fpmAccepts,
  now = Date.now,
  maxPerSite = MAX_REPAIRS_PER_SITE,
  windowMs = REPAIR_WINDOW_MS,
}) {
  const records = new Map(); // domain -> { state, error, history: [ts] }
  const inflight = new Map(); // version -> { domains: Set, promise }

  const resolve = (host) => siteForHost(sites(), host, activePhpVersion);

  function record(domain) {
    let rec = records.get(domain);
    if (!rec) {
      rec = { state: 'idle', error: null, history: [] };
      records.set(domain, rec);
    }
    return rec;
  }

  function view(site) {
    const rec = records.get(site.domain) || { state: 'idle', error: null };
    return {
      state: rec.state,
      step: rec.state === 'repairing' ? 'restart-php' : null,
      phpVersion: site.phpVersion,
      error: rec.error,
    };
  }

  // Restarts `version` once and settles every Site that joined meanwhile.
  async function run(version, job) {
    let error = null;
    try {
      await restartFpm(version);
      if (!(await fpmAccepts(version))) {
        error = `PHP ${version} restarted but isn't accepting connections.`;
      }
    } catch (err) {
      error = (err && err.message) || String(err);
    }
    if (inflight.get(version) === job) inflight.delete(version);
    for (const domain of job.domains) {
      const rec = record(domain);
      rec.state = error ? 'failed' : 'healthy';
      rec.error = error;
    }
  }

  function status(host) {
    const site = resolve(host);
    return site ? view(site) : null;
  }

  function repair(host) {
    const site = resolve(host);
    if (!site) return Promise.resolve(null);
    const rec = record(site.domain);
    const version = site.phpVersion;
    let job = inflight.get(version);
    if (!job) {
      const t = now();
      rec.history = rec.history.filter((x) => x <= t && t - x < windowMs);
      if (rec.history.length >= maxPerSite) {
        rec.state = 'limited';
        rec.error =
          `PHP ${version} was restarted ${rec.history.length} times in the last minute` +
          ' — WPXen stopped to avoid hiding a crash loop.';
        return Promise.resolve(view(site));
      }
      rec.history.push(t);
    }
    // Marked before the restart starts: run() may settle synchronously.
    rec.state = 'repairing';
    rec.error = null;
    if (job) {
      job.domains.add(site.domain);
    } else {
      job = { domains: new Set([site.domain]), promise: null };
      inflight.set(version, job);
      job.promise = run(version, job);
    }
    return job.promise.then(() => view(site));
  }

  return { status, repair };
}

// The running endpoint, wired to the real collaborators. Started with the app
// (main.cjs) and closed on quit; the socket file goes with it.
let service = null;

function startRepairService({ sites }) {
  if (service) return service;
  const socketPath = repairSocketPath();
  if (!socketPath) return Promise.resolve(null); // no Homebrew, no nginx to serve the page
  const repairer = createRepairer({
    sites,
    activePhpVersion: () => brew.getActivePhpVersion(),
    restartFpm: (version) => php.restartPhpFpm(version),
    fpmAccepts: (version) => php.fpmAccepts(version),
  });
  service = repairServer.listen({ socketPath, repairer }).catch((err) => {
    service = null;
    throw err;
  });
  return service;
}

async function stopRepairService() {
  const pending = service;
  service = null;
  const server = pending && (await pending.catch(() => null));
  if (server) await server.close();
}

module.exports = {
  REPAIR_SOCKET_NAME,
  RESERVED_PREFIX,
  MAX_REPAIRS_PER_SITE,
  REPAIR_WINDOW_MS,
  repairSocketPath,
  siteForHost,
  createRepairer,
  startRepairService,
  stopRepairService,
};
