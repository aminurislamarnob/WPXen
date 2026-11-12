'use strict';

// Self-healing 502. When nginx can't reach a Site's PHP-FPM it serves WPXen's
// error page (errorPages.cjs), which asks this module — through the Unix-socket
// server in repairServer.cjs — to repair the Site, and polls for the result.
//
// The caller only ever names a host. The host maps to a known Site and that
// Site's PHP version; nothing else (a command, a path, a version) is taken
// from the request.

const fs = require('fs');
const brew = require('./brew.cjs');
const php = require('./php.cjs');
const repairServer = require('./repairServer.cjs');

// Names that carry the app's name outside its bundle (see CLAUDE.md, "Legacy
// names") — a future rename has to find and migrate these.
const REPAIR_SOCKET_NAME = 'wpxen-repair.sock';
// The URL prefix the shared nginx snippet reserves on every Site. Defined
// beside the routes it prefixes (repairServer.cjs requires nothing of ours).
const RESERVED_PREFIX = repairServer.RESERVED_PREFIX;

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

// PHP-FPM's own words for why it's down, from its process log (procman's
// capture of its stdout/stderr: a config it can't parse is reported there,
// before FPM opens its own error_log). Routine NOTICE/DEBUG chatter is
// dropped; anything else is kept — a loader failure (`dyld: Library not
// loaded`) has no level at all. The last few lines, or null. Pure.
const MAX_ERROR_LINES = 8;
const MAX_ERROR_CHARS = 2000;

function fpmErrorText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !/\b(NOTICE|DEBUG): /.test(l));
  if (!lines.length) return null;
  const out = lines.slice(-MAX_ERROR_LINES).join('\n');
  return out.length > MAX_ERROR_CHARS ? out.slice(-MAX_ERROR_CHARS) : out;
}

// A log's current end — taken before a repair so only what that repair's
// restart wrote is reported, never an error from an earlier run.
function logMark(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

// What `filePath` gained since `mark`, at most its last `maxBytes`, starting
// on a whole line. A log smaller than the mark was rotated (procman renames
// it aside on spawn) and is read from its start. Sync: status answers sync.
function readLogSince(filePath, mark, maxBytes = 16 * 1024) {
  let fd;
  try {
    const { size } = fs.statSync(filePath);
    const from = size < mark ? 0 : mark;
    const start = Math.max(from, size - maxBytes);
    const len = size - start;
    if (len <= 0) return '';
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > from) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The steps a repair escalates through, lightest first. Each later one runs
// only if the Site's PHP-FPM socket still refuses connections after the one
// before; the first after which it accepts ends the repair. No step touches
// another PHP version or MySQL.
const STEPS = ['restart-php', 'reload-nginx', 'restart-nginx'];

// The repair engine. Collaborators are injected so it runs under plain Node:
//   sites()             → the store's Sites
//   activePhpVersion()  → the version a Site with none runs on
//   restartFpm(version) → restart that one version's FPM (throws on failure)
//   fpmAccepts(version) → does its socket accept connections now
//   fpmLogMark(version) → the end of that version's PHP-FPM process log
//   fpmLogSince(version, mark) → what the log gained since the mark
//   reloadNginx()       → reload nginx's config (throws on failure)
//   restartNginx()      → restart nginx (throws on failure)
//
// status(host) / repair(host) return null for a host that is no known Site;
// otherwise { state, step, phpVersion, error } where state is idle |
// repairing | healthy | failed | limited and step (one of STEPS) names what's
// running while repairing.
function createRepairer({
  sites,
  activePhpVersion,
  restartFpm,
  fpmAccepts,
  fpmLogMark = () => 0,
  fpmLogSince = () => '',
  reloadNginx,
  restartNginx,
  now = Date.now,
  maxPerSite = MAX_REPAIRS_PER_SITE,
  windowMs = REPAIR_WINDOW_MS,
}) {
  const records = new Map(); // domain -> { state, error, history: [ts], job }
  const inflight = new Map(); // version -> { domains: Set, step, promise }
  // nginx is one process for every version: two versions escalating at once
  // share the reload or restart already running rather than doing it twice.
  const nginxRuns = new Map(); // step -> promise
  const nginxSteps = { 'reload-nginx': reloadNginx, 'restart-nginx': restartNginx };

  function nginx(step) {
    let p = nginxRuns.get(step);
    if (!p) {
      p = Promise.resolve()
        .then(() => nginxSteps[step]())
        .finally(() => nginxRuns.delete(step));
      nginxRuns.set(step, p);
    }
    return p;
  }

  const accepts = (version) => Promise.resolve(fpmAccepts(version)).catch(() => false);
  const message = (err) => (err && err.message) || String(err);

  // PHP-FPM's error text from what this job's restart wrote to its log.
  function logError(version, job) {
    try {
      return fpmErrorText(fpmLogSince(version, job.mark));
    } catch {
      return null;
    }
  }

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
    const job = rec.state === 'repairing' ? rec.job : null;
    return {
      state: rec.state,
      step: job ? job.step : null,
      phpVersion: site.phpVersion,
      // While a restart runs, whatever PHP-FPM has complained about so far:
      // a broken config shows on the page in seconds, not after the
      // supervisor's ready window runs out.
      error: job ? logError(site.phpVersion, job) : rec.error,
    };
  }

  // Repairs `version` once, escalating through STEPS, and settles every Site
  // that joined meanwhile.
  async function run(version, job) {
    let error = null;
    try {
      job.mark = fpmLogMark(version);
    } catch {
      job.mark = 0;
    }
    let ok = false;
    let fpmFailed = false;
    try {
      await restartFpm(version);
      ok = await accepts(version);
      if (!ok) error = `PHP ${version} restarted but isn't accepting connections.`;
    } catch (err) {
      // PHP-FPM couldn't even start (a broken config, a missing binary):
      // nothing nginx does can fix that, so don't disturb every other Site.
      error = message(err);
      fpmFailed = true;
    }
    for (const step of STEPS.slice(1)) {
      if (ok || fpmFailed) break;
      job.step = step;
      try {
        await nginx(step);
      } catch (err) {
        error = `${error} ${step === 'reload-nginx' ? 'Reloading' : 'Restarting'} nginx failed: ${message(err)}`;
        continue;
      }
      ok = await accepts(version);
    }
    // On failure PHP-FPM's own words beat any summary of ours.
    if (!ok) error = logError(version, job) || error;
    if (inflight.get(version) === job) inflight.delete(version);
    for (const domain of job.domains) {
      const rec = record(domain);
      rec.state = ok ? 'healthy' : 'failed';
      rec.error = ok ? null : error;
      rec.job = null;
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
      job = { domains: new Set([site.domain]), step: STEPS[0], mark: 0, promise: null };
      inflight.set(version, job);
    }
    rec.job = job;
    if (!job.promise) job.promise = run(version, job);
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
    fpmLogMark: (version) => logMark(php.fpmLogPath(version)),
    fpmLogSince: (version, mark) => readLogSince(php.fpmLogPath(version), mark),
    // Required here, not at the top: nginx.cjs → errorPages.cjs → this module.
    reloadNginx: () => require('./nginx.cjs').reloadChecked(),
    restartNginx: () => require('./nginx.cjs').restart(),
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
  STEPS,
  fpmErrorText,
  logMark,
  readLogSince,
  repairSocketPath,
  siteForHost,
  createRepairer,
  startRepairService,
  stopRepairService,
};
