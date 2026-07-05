'use strict';

const { spawn, execSync, execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dns = require('dns').promises;
const brew = require('./brew.cjs');
const nginx = require('./nginx.cjs');
const wordpress = require('./wordpress.cjs');
const execAsync = require('./asyncExec.cjs');

const execFileAsync = promisify(execFile);

// Resolves the cloudflared binary. Prefer the Homebrew-installed one, then fall
// back to whatever is on PATH.
function getCloudflaredPath() {
  const prefix = brew.getBrewPrefix();
  if (prefix && fs.existsSync(`${prefix}/bin/cloudflared`)) {
    return `${prefix}/bin/cloudflared`;
  }
  try {
    const p = execSync('which cloudflared', { stdio: ['ignore', 'pipe', 'pipe'] })
      .toString()
      .trim();
    return p || null;
  } catch {
    return null;
  }
}

function isInstalled() {
  return !!getCloudflaredPath();
}

async function isInstalledAsync() {
  const prefix = brew.getBrewPrefix();
  if (prefix && fs.existsSync(`${prefix}/bin/cloudflared`)) return true;
  try {
    await execAsync('which cloudflared', { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

// Installs cloudflared via Homebrew, streaming output lines to `onProgress`.
function install(onProgress) {
  return new Promise((resolve, reject) => {
    const brewBin = brew.getBrewPath();
    if (!brewBin) {
      reject(new Error('Homebrew is not installed'));
      return;
    }
    const prefix = brew.getBrewPrefix();
    const child = spawn(brewBin, ['install', 'cloudflared'], {
      env: {
        ...process.env,
        PATH: `${prefix}/bin:${process.env.PATH}`,
        HOMEBREW_NO_AUTO_UPDATE: '1',
        HOMEBREW_NO_ENV_HINTS: '1',
      },
    });
    let tail = '';
    const emit = (buf) => {
      const text = buf.toString();
      tail = (tail + text).slice(-4000);
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && typeof onProgress === 'function') onProgress(trimmed);
      }
    };
    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(tail.trim() || `cloudflared install failed (exit ${code})`));
    });
  });
}

// ─── Cloudflare account (named tunnels) ────────────────────────────────────
//
// Quick tunnels need no account but mint a new random *.trycloudflare.com URL
// every start. Named tunnels give a stable hostname on the user's own
// Cloudflare-managed domain: `tunnel login` writes ~/.cloudflared/cert.pem,
// `tunnel create` mints a UUID + credentials JSON, `tunnel route dns` points a
// CNAME at it, and `tunnel run` serves it.

function getCertPath() {
  return path.join(os.homedir(), '.cloudflared', 'cert.pem');
}

function isLoggedIn() {
  return fs.existsSync(getCertPath());
}

function getTunnelCredentialsPath(tunnelId) {
  return path.join(os.homedir(), '.cloudflared', `${tunnelId}.json`);
}

// Deterministic per-site tunnel name, e.g. "wpherd-demo-test".
function tunnelNameForSite(site) {
  const slug = String(site.domain || site.name || site.id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `wpherd-${slug}`.slice(0, 63);
}

// Extracts the tunnel UUID from `cloudflared tunnel create` output.
function parseTunnelCreateOutput(text) {
  const m = String(text || '').match(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i
  );
  return m ? m[0].toLowerCase() : null;
}

// Argv for `tunnel run` — flags mirror the quick-tunnel spawn (same origin and
// TLS-verify logic), with the tunnel UUID as the trailing positional.
function buildNamedRunArgs(site, tunnelId) {
  const origin = site.https ? 'https://localhost:443' : 'http://localhost:80';
  const args = ['tunnel', '--no-autoupdate', 'run', '--url', origin];
  if (site.https) args.push('--no-tls-verify');
  args.push(tunnelId);
  return args;
}

// Opens the Cloudflare browser login. cloudflared launches the browser itself;
// we stream its output lines and resolve once cert.pem lands.
function login(onLine = () => {}) {
  return new Promise((resolve, reject) => {
    const bin = getCloudflaredPath();
    if (!bin) {
      reject(new Error('cloudflared is not installed.'));
      return;
    }
    const child = spawn(bin, ['tunnel', 'login'], { env: { ...process.env } });
    let tail = '';
    let timedOut = false;
    const emit = (buf) => {
      const text = buf.toString();
      tail = (tail + text).slice(-4000);
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) onLine(trimmed);
      }
    };
    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    // The user has five minutes to finish the browser flow.
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {}
    }, 300000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && isLoggedIn()) resolve();
      else if (timedOut) reject(new Error('Cloudflare login timed out.'));
      else reject(new Error(tail.trim() || `Cloudflare login failed (exit ${code}).`));
    });
  });
}

// Returns { tunnelId, tunnelName } for the site, reusing the persisted tunnel
// when its credentials file still exists, otherwise creating (or adopting) one.
async function ensureNamedTunnel(site) {
  const prevId = site.share && site.share.tunnelId;
  if (prevId && fs.existsSync(getTunnelCredentialsPath(prevId))) {
    return {
      tunnelId: prevId,
      tunnelName: (site.share && site.share.tunnelName) || tunnelNameForSite(site),
    };
  }

  const bin = getCloudflaredPath();
  const name = tunnelNameForSite(site);
  let out = '';
  try {
    const res = await execFileAsync(bin, ['tunnel', 'create', name], { timeout: 30000 });
    out = `${res.stdout || ''}\n${res.stderr || ''}`;
  } catch (err) {
    // The tunnel may already exist from a previous run — fall through to list.
    out = `${err.stdout || ''}\n${err.stderr || ''}`;
  }

  let tunnelId = parseTunnelCreateOutput(out);
  if (!tunnelId) {
    const res = await execFileAsync(bin, ['tunnel', 'list', '--output', 'json'], {
      timeout: 30000,
    });
    try {
      const rows = JSON.parse(res.stdout || '[]');
      const row = rows.find((r) => r.name === name && !r.deleted_at);
      if (row) tunnelId = String(row.id).toLowerCase();
    } catch {
      // Unparseable list output — handled below.
    }
  }
  if (!tunnelId) {
    throw new Error(`Could not create the Cloudflare tunnel "${name}".`);
  }
  return { tunnelId, tunnelName: name };
}

// Points a CNAME for `hostname` at the tunnel. Re-running for the same tunnel
// is treated as success (idempotent restarts); a record owned by something
// else surfaces Cloudflare's error verbatim.
async function routeDns(tunnelId, hostname) {
  const bin = getCloudflaredPath();
  try {
    await execFileAsync(bin, ['tunnel', 'route', 'dns', tunnelId, hostname], {
      timeout: 30000,
    });
  } catch (err) {
    const msg = `${err.stdout || ''}\n${err.stderr || ''}`.trim() || err.message;
    if (/already configured to route/i.test(msg)) return;
    if (/record with that host already exists/i.test(msg)) {
      throw new Error(
        `A DNS record for ${hostname} already exists in Cloudflare and points elsewhere. ` +
          'Remove it in the Cloudflare dashboard or pick another hostname.'
      );
    }
    throw new Error(msg);
  }
}

// Deletes the named tunnel in Cloudflare (site removal / mode switch). The DNS
// CNAME cannot be deleted via cloudflared — the UI tells the user to clean it
// up in the dashboard.
async function deleteNamedTunnel(tunnelId) {
  const bin = getCloudflaredPath();
  if (!bin || !tunnelId) return;
  await execFileAsync(bin, ['tunnel', 'delete', '-f', tunnelId], { timeout: 30000 });
}

// Live tunnels, keyed by site id. Each value is a serializable snapshot plus the
// underlying child process (stripped out before sending to the renderer).
//   { siteId, domain, status, url, error, proc }
// status: 'starting' | 'running' | 'error' | 'stopped'
const tunnels = new Map();

function snapshot(t) {
  if (!t) return null;
  return {
    siteId: t.siteId,
    domain: t.domain,
    status: t.status,
    url: t.url || null,
    error: t.error || null,
    authEnabled: !!t.authEnabled,
    mode: t.mode || 'quick',
    tunnelId: t.tunnelId || null,
    tunnelName: t.tunnelName || null,
  };
}

function getTunnel(siteId) {
  return snapshot(tunnels.get(siteId));
}

function getAllTunnels() {
  return [...tunnels.values()].map(snapshot);
}

// Polls DNS until the fresh quick-tunnel host is publicly resolvable.
//
// Cloudflare hands out a brand-new random *.trycloudflare.com subdomain on every
// start. It takes a few seconds to propagate to public resolvers (8.8.8.8 etc).
// If the user opens the URL in that window, the lookup returns NXDOMAIN and macOS
// mDNSResponder *negative-caches* it — so the URL then looks permanently dead
// ("ERR_NAME_NOT_RESOLVED") for the whole negative-TTL even after DNS goes live.
//
// We use dns.resolve4 (c-ares, querying the configured nameservers directly)
// rather than dns.lookup (getaddrinfo) on purpose: resolve4 bypasses the OS
// resolver cache, so our polling never itself poisons that cache. Once this
// succeeds the record exists upstream, so the browser's first lookup resolves
// positively. Best-effort: resolves false on timeout and the caller proceeds
// anyway (the URL will start working once DNS catches up).
function waitForDnsReady(host, { timeoutMs = 30000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = async () => {
      try {
        const addrs = await dns.resolve4(host);
        if (addrs && addrs.length) return resolve(true);
      } catch {
        // not resolvable yet
      }
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(attempt, intervalMs);
    };
    attempt();
  });
}

// Adds the given public host to the site's nginx vhost server_name so requests
// arriving on the tunnel host route to this site, then reloads nginx.
function addNginxAlias(site, host) {
  const aliases = Array.isArray(site.aliases) ? [...site.aliases] : [];
  if (!aliases.includes(host)) aliases.push(host);
  nginx.createSiteConfig({ ...site, aliases });
  nginx.reload();
}

// Restores the site's vhost to its plain form (no tunnel alias).
function clearNginxAlias(site) {
  try {
    nginx.createSiteConfig({ ...site, aliases: [] });
    nginx.reload();
  } catch {
    // Site may have been removed; nothing to restore.
  }
}

// Re-applies a live tunnel's nginx alias with the site's current settings —
// used when share options (e.g. basic-auth) change mid-tunnel. The caller
// passes the fresh site object, with `shareAuthFile` attached when auth is on.
// Returns the updated snapshot, or null when no tunnel with a URL is live.
function refreshTunnel(siteId, site) {
  const record = tunnels.get(siteId);
  if (!record || !record.url) return null;
  const host = record.url.replace(/^https:\/\//, '');
  addNginxAlias(site, host);
  record.site = site;
  record.authEnabled = !!(site.share && site.share.authEnabled);
  return snapshot(record);
}

// Unexpected-exit retry schedule for named tunnels. Quick tunnels keep their
// delete-on-exit behavior (the random URL dies with the process anyway), but a
// stable share is worth restoring automatically.
const NAMED_RETRY_DELAYS = [2000, 5000, 15000];

// Spawns `tunnel run` for a named-tunnel record and wires state transitions,
// including crash-retry. The record's promise settles via record.settle.
function spawnNamedProc(record, onUpdate) {
  const bin = getCloudflaredPath();
  const proc = spawn(bin, buildNamedRunArgs(record.site, record.tunnelId), {
    env: { ...process.env },
  });
  record.proc = proc;

  let tail = '';
  const onData = (buf) => {
    const text = buf.toString();
    tail = (tail + text).slice(-4000);
    // cloudflared logs "Registered tunnel connection" once an edge connection
    // is up — the share is reachable from that point.
    if (record.status === 'starting' && /Registered tunnel connection/i.test(text)) {
      markNamedRunning(record, onUpdate);
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  // Grace timer: if the "registered" line never shows (log format drift), flip
  // to running anyway after 20s rather than hanging in 'starting'.
  const graceTimer = setTimeout(() => {
    if (record.status === 'starting') markNamedRunning(record, onUpdate);
  }, 20000);

  proc.on('error', (err) => {
    clearTimeout(graceTimer);
    record.status = 'error';
    record.error = err.message;
    onUpdate(snapshot(record));
    settleNamed(record, err);
  });

  proc.on('close', (code) => {
    clearTimeout(graceTimer);
    record.proc = null;

    if (record.status === 'stopped') {
      // Clean stop requested by us. Settle a still-pending start so callers
      // (e.g. the start-tunnel IPC) never hang on a stopped tunnel.
      clearNginxAlias(record.site);
      onUpdate(snapshot(record));
      if (tunnels.get(record.siteId) === record) tunnels.delete(record.siteId);
      settleNamed(record, new Error('Tunnel stopped before it was ready.'));
      return;
    }

    // Unexpected exit after the tunnel had been running: retry with backoff —
    // the hostname is stable, so a respawn restores the share. A first-start
    // failure (record never settled) fails fast instead, so a hard error like
    // revoked credentials isn't masked behind 20s of doomed retries.
    if (record.settled && record.retries < NAMED_RETRY_DELAYS.length) {
      const delay = NAMED_RETRY_DELAYS[record.retries];
      record.retries += 1;
      record.status = 'starting';
      onUpdate(snapshot(record));
      setTimeout(() => {
        if (record.status !== 'starting' || tunnels.get(record.siteId) !== record) return;
        spawnNamedProc(record, onUpdate);
      }, delay);
      return;
    }

    record.status = 'error';
    record.error = tail.trim() || `cloudflared exited (code ${code}).`;
    clearNginxAlias(record.site);
    onUpdate(snapshot(record));
    if (tunnels.get(record.siteId) === record) tunnels.delete(record.siteId);
    settleNamed(record, new Error(record.error));
  });
}

function markNamedRunning(record, onUpdate) {
  if (record.status !== 'starting') return;
  // Hold in 'starting' until the hostname resolves publicly — a fresh CNAME
  // takes a few seconds; an existing record resolves on the first query.
  waitForDnsReady(record.hostname, { timeoutMs: 15000 }).then(() => {
    if (record.status !== 'starting' || tunnels.get(record.siteId) !== record) return;
    record.status = 'running';
    record.retries = 0;
    onUpdate(snapshot(record));
    settleNamed(record, null, snapshot(record));
  });
}

function settleNamed(record, err, value) {
  if (record.settled || !record.settle) return;
  record.settled = true;
  if (err) record.settle.reject(err);
  else record.settle.resolve(value);
}

// Starts a named tunnel: ensures the tunnel exists in the account, routes the
// DNS CNAME, adds the nginx alias (URL is known upfront), then runs it.
async function startNamedTunnel(site, onUpdate = () => {}) {
  const bin = getCloudflaredPath();
  if (!bin) throw new Error('cloudflared is not installed.');

  const existing = tunnels.get(site.id);
  if (existing && (existing.status === 'running' || existing.status === 'starting')) {
    return snapshot(existing);
  }

  const hostname = site.share && site.share.hostname;
  if (!hostname) throw new Error('Set a hostname for the stable share first.');
  if (!isLoggedIn()) {
    throw new Error('Connect your Cloudflare account first (see Share options).');
  }

  // Ensure WordPress emits share-host URLs when reached through the tunnel.
  try {
    wordpress.ensureTunnelMuPlugin(site.path);
  } catch {}

  const { tunnelId, tunnelName } = await ensureNamedTunnel(site);
  await routeDns(tunnelId, hostname);

  const record = {
    siteId: site.id,
    domain: site.domain,
    status: 'starting',
    url: `https://${hostname}`,
    error: null,
    authEnabled: !!(site.share && site.share.authEnabled),
    mode: 'named',
    hostname,
    tunnelId,
    tunnelName,
    proc: null,
    site,
    settled: false,
    settle: null,
    retries: 0,
  };
  tunnels.set(site.id, record);
  onUpdate(snapshot(record));

  try {
    // Route the public hostname to this site's vhost. Assumption (validated in
    // testing): like quick tunnels, `tunnel run --url` forwards the original
    // public Host header; if that ever changes, add
    // `--http-host-header <hostname>` to buildNamedRunArgs.
    addNginxAlias(site, hostname);
  } catch (err) {
    tunnels.delete(site.id);
    record.status = 'error';
    record.error = `nginx routing failed: ${err.message}`;
    onUpdate(snapshot(record));
    throw new Error(record.error);
  }

  return new Promise((resolve, reject) => {
    record.settle = { resolve, reject };
    spawnNamedProc(record, onUpdate);
  });
}

// Starts a share tunnel for a site — a named (stable-hostname) tunnel when the
// site's share mode says so, otherwise a quick tunnel. `onUpdate(snapshot)` is
// invoked whenever the tunnel's state changes (url captured, error, exit).
// Resolves with the running snapshot once the share is reachable, or rejects.
function startTunnel(site, onUpdate = () => {}) {
  if (site.share && site.share.mode === 'named') {
    return startNamedTunnel(site, onUpdate);
  }
  return new Promise((resolve, reject) => {
    const bin = getCloudflaredPath();
    if (!bin) {
      reject(new Error('cloudflared is not installed.'));
      return;
    }

    const existing = tunnels.get(site.id);
    if (existing && (existing.status === 'running' || existing.status === 'starting')) {
      resolve(snapshot(existing));
      return;
    }

    // Ensure WordPress emits tunnel-host URLs when reached through the share.
    try {
      wordpress.ensureTunnelMuPlugin(site.path);
    } catch {}

    // Point cloudflared at the local origin. For https sites we target 443 with
    // TLS verification disabled (the mkcert cert is issued for the .test domain,
    // not localhost) so the http→https redirect on :80 can't create a loop.
    //
    // We deliberately do NOT set --http-host-header: cloudflared forwards the
    // original request Host (the random *.trycloudflare.com host). nginx routes
    // it via the server_name alias we add below, and WordPress sees the real
    // tunnel host so the mu-plugin can emit matching public URLs.
    const origin = site.https ? 'https://localhost:443' : 'http://localhost:80';
    const args = ['tunnel', '--no-autoupdate', '--url', origin];
    if (site.https) args.push('--no-tls-verify');

    const proc = spawn(bin, args, { env: { ...process.env } });

    const record = {
      siteId: site.id,
      domain: site.domain,
      status: 'starting',
      url: null,
      error: null,
      authEnabled: !!(site.share && site.share.authEnabled),
      proc,
      site,
      settled: false,
    };
    tunnels.set(site.id, record);
    onUpdate(snapshot(record));

    let tail = '';
    // cloudflared prints the quick-tunnel URL to stderr, e.g.
    //   https://random-words-1234.trycloudflare.com
    const urlRe = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

    const onData = (buf) => {
      const text = buf.toString();
      tail = (tail + text).slice(-4000);
      if (record.status === 'starting' && !record.url) {
        const m = text.match(urlRe);
        if (m) {
          const url = m[0];
          const host = url.replace(/^https:\/\//, '');
          record.url = url;
          try {
            addNginxAlias(site, host);
          } catch (err) {
            record.status = 'error';
            record.error = `Tunnel started but nginx routing failed: ${err.message}`;
            onUpdate(snapshot(record));
            if (!record.settled) {
              record.settled = true;
              reject(new Error(record.error));
            }
            try {
              proc.kill();
            } catch {}
            return;
          }
          // Hold in 'starting' until the fresh subdomain actually resolves, so we
          // never surface a URL that the browser would negative-cache as NXDOMAIN.
          waitForDnsReady(host).then(() => {
            if (record.settled || record.status === 'stopped') return;
            record.status = 'running';
            onUpdate(snapshot(record));
            record.settled = true;
            resolve(snapshot(record));
          });
        }
      }
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('error', (err) => {
      record.status = 'error';
      record.error = err.message;
      onUpdate(snapshot(record));
      if (!record.settled) {
        record.settled = true;
        reject(err);
      }
    });

    proc.on('close', (code) => {
      clearNginxAlias(site);
      // A clean stop (killed by us) leaves status 'stopped'; an unexpected exit
      // before we captured a URL is an error.
      if (record.status !== 'stopped') {
        if (record.status === 'running') {
          record.status = 'stopped';
        } else {
          record.status = 'error';
          record.error =
            record.error || tail.trim() || `cloudflared exited (code ${code}).`;
        }
      }
      record.proc = null;
      onUpdate(snapshot(record));
      // Drop stopped/errored tunnels from the map so the UI resets cleanly.
      const current = tunnels.get(site.id);
      if (current === record) tunnels.delete(site.id);
      if (!record.settled) {
        record.settled = true;
        reject(new Error(record.error || 'Tunnel closed before it was ready.'));
      }
    });

    // Safety net: if cloudflared never prints a URL within 30s, treat it as a
    // failure. Once a URL is captured we're in the DNS-readiness wait (bounded
    // separately in waitForDnsReady), so don't kill the tunnel for that.
    const timer = setTimeout(() => {
      if (record.status === 'starting' && !record.url && !record.settled) {
        record.error = 'Timed out waiting for the tunnel URL.';
        try {
          proc.kill();
        } catch {}
      }
    }, 30000);
    proc.on('close', () => clearTimeout(timer));
  });
}

// Stops a site's tunnel and restores its nginx vhost.
function stopTunnel(siteId) {
  const record = tunnels.get(siteId);
  if (!record) return false;
  record.status = 'stopped';
  if (record.proc) {
    try {
      record.proc.kill();
    } catch {}
  } else {
    // No live process (e.g. a named tunnel waiting out a retry backoff).
    clearNginxAlias(record.site);
    tunnels.delete(siteId);
    settleNamed(record, new Error('Tunnel stopped before it was ready.'));
  }
  return true;
}

// Kills every running tunnel — used on app quit so no orphan cloudflared
// processes linger and no stale nginx aliases remain.
function stopAll() {
  for (const id of [...tunnels.keys()]) {
    stopTunnel(id);
  }
}

module.exports = {
  getCloudflaredPath,
  isInstalled,
  isInstalledAsync,
  install,
  startTunnel,
  stopTunnel,
  stopAll,
  getTunnel,
  getAllTunnels,
  refreshTunnel,
  // Named tunnels (stable hostnames)
  isLoggedIn,
  login,
  deleteNamedTunnel,
  // Exported for tests
  tunnelNameForSite,
  parseTunnelCreateOutput,
  buildNamedRunArgs,
};
