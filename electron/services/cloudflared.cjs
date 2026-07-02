'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const brew = require('./brew.cjs');
const nginx = require('./nginx.cjs');
const wordpress = require('./wordpress.cjs');
const execAsync = require('./asyncExec.cjs');

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
  };
}

function getTunnel(siteId) {
  return snapshot(tunnels.get(siteId));
}

function getAllTunnels() {
  return [...tunnels.values()].map(snapshot);
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

// Starts a Cloudflare quick tunnel for a site. `onUpdate(snapshot)` is invoked
// whenever the tunnel's state changes (url captured, error, exit). Resolves with
// the running snapshot once the public URL is captured, or rejects on failure.
function startTunnel(site, onUpdate = () => {}) {
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
      if (record.status === 'starting') {
        const m = text.match(urlRe);
        if (m) {
          const url = m[0];
          const host = url.replace(/^https:\/\//, '');
          record.url = url;
          record.status = 'running';
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
          onUpdate(snapshot(record));
          if (!record.settled) {
            record.settled = true;
            resolve(snapshot(record));
          }
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

    // Safety net: if no URL appears within 30s, treat it as a failure.
    const timer = setTimeout(() => {
      if (record.status === 'starting' && !record.settled) {
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
    clearNginxAlias(record.site);
    tunnels.delete(siteId);
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
};
