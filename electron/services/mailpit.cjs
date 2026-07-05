'use strict';

// Catches outgoing email from all sites. Mailpit runs a local SMTP sink
// (127.0.0.1:1025) with a web inbox and REST API (127.0.0.1:8025). PHP's
// mail() — and therefore wp_mail() — is routed into it by pointing
// sendmail_path at `mailpit sendmail` via a WPHerd-managed conf.d override,
// so no WordPress plugin or per-site change is needed.

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const brew = require('./brew.cjs');
const php = require('./php.cjs');
const execAsync = require('./asyncExec.cjs');
const procman = require('./procman.cjs');

const UI_PORT = 8025;
const API_BASE = `http://127.0.0.1:${UI_PORT}/api/v1`;

// Prefer the keg's opt path (stable across upgrades) over the prefix bin
// symlink, since this exact path gets baked into php.ini sendmail_path.
function getBinPath() {
  const prefix = brew.getBrewPrefix();
  if (!prefix) return null;
  const optPath = `${prefix}/opt/mailpit/bin/mailpit`;
  if (fs.existsSync(optPath)) return optPath;
  const linkedPath = `${prefix}/bin/mailpit`;
  if (fs.existsSync(linkedPath)) return linkedPath;
  return null;
}

function isInstalled() {
  return !!getBinPath();
}

// Installs Mailpit via Homebrew, streaming output lines to `onProgress`.
// Bottled, so it's quick and needs no sudo.
function install(onProgress) {
  return new Promise((resolve, reject) => {
    const brewBin = brew.getBrewPath();
    if (!brewBin) {
      reject(new Error('Homebrew is not installed'));
      return;
    }
    const prefix = brew.getBrewPrefix();
    const child = spawn(brewBin, ['install', 'mailpit'], {
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
      else reject(new Error(tail.trim() || `Mailpit install failed (exit ${code})`));
    });
  });
}

function isRunning() {
  try {
    // launchd starts mailpit via absolute path (see nginx.isRunning), so
    // `pgrep -x` alone can miss it — fall back to a full-args path match.
    execSync("pgrep -x mailpit || pgrep -f '[/ ]mailpit$'", { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Non-blocking variant used by the status poller (see asyncExec.cjs).
async function isRunningAsync() {
  try {
    await execAsync("pgrep -x mailpit || pgrep -f '[/ ]mailpit$'", {
      timeout: 4000,
    });
    return true;
  } catch {
    return false;
  }
}

// Mailpit runs as a supervised child of WPHerd (see procman.cjs) — no launchd
// registration, so it never shows up in macOS "App Background Activity".
function buildSpec() {
  const bin = getBinPath();
  if (!bin) throw new Error('Mailpit is not installed.');
  const prefix = brew.getBrewPrefix();
  return {
    name: 'mailpit',
    bin,
    args: [],
    cwd: `${prefix}/var`,
    stopSignal: 'SIGTERM',
    stopTimeoutMs: 5000,
    // Ready once the HTTP API answers — callers can query it immediately.
    readyProbe: async () => {
      try {
        const res = await fetch(`${API_BASE}/info`, {
          signal: AbortSignal.timeout(1500),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    readyTimeoutMs: 15_000,
    // An instance may still be running from launchd (pre-migration) — clear it.
    conflictProbe: isRunningAsync,
    takeover: async () => {
      try {
        brew.stopBrewService('mailpit');
      } catch {}
    },
  };
}

function start() {
  return procman.start(buildSpec());
}

function stop() {
  return procman.stop('mailpit');
}

function restart() {
  return procman.restart(buildSpec());
}

function getUrl(messageId) {
  const base = `http://127.0.0.1:${UI_PORT}/`;
  if (!messageId) return base;
  return `${base}view/${encodeURIComponent(messageId)}`;
}

// ─── PHP sendmail override ──────────────────────────────────────────────────
//
// One WPHerd-managed ini per installed PHP version (loaded last from conf.d).
// Kept separate from zz-wpherd.ini so the numeric-settings round-tripper there
// never sees or clobbers it.

function getManagedIniPath(version) {
  const prefix = brew.getBrewPrefix();
  if (!prefix) return null;
  return `${prefix}/etc/php/${version}/conf.d/zz-wpherd-mailpit.ini`;
}

function buildIni() {
  // `-t` makes mailpit read recipients from the message headers, matching how
  // PHP invokes the real sendmail (`sendmail -t -i`) — mail() passes no
  // recipient arguments on the command line.
  return [
    '; Managed by WPHerd — routes PHP mail() into Mailpit.',
    `sendmail_path = "${getBinPath()} sendmail -t"`,
    '',
  ].join('\n');
}

// Writes (or removes) the sendmail override for every installed PHP version,
// reloading only the FPM masters whose config actually changed. Idempotent —
// safe to re-run on startup and after new PHP versions are installed.
function setCatchEnabled(enabled) {
  if (enabled && !isInstalled()) {
    throw new Error('Mailpit is not installed.');
  }
  const desired = enabled ? buildIni() : null;
  for (const version of brew.getInstalledPhpVersions()) {
    const p = getManagedIniPath(version);
    if (!p) continue;
    let changed = false;
    if (enabled) {
      const current = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
      if (current !== desired) {
        const dir = path.dirname(p);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(p, desired, 'utf8');
        changed = true;
      }
    } else if (fs.existsSync(p)) {
      fs.rmSync(p, { force: true });
      changed = true;
    }
    if (changed) php.reloadPhpFpmIfRunning(version);
  }
}

// True when any installed PHP version carries the override — used to detect
// drift between the stored setting and what's actually on disk.
function isCatchConfigured() {
  return brew.getInstalledPhpVersions().some((v) => {
    const p = getManagedIniPath(v);
    return !!p && fs.existsSync(p);
  });
}

// ─── Mailpit REST API ───────────────────────────────────────────────────────

async function api(pathname, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}${pathname}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new Error('Could not reach Mailpit. Is the service running?');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text.trim() || `Mailpit API error (${res.status})`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

const MESSAGE_ID_RE = /^[A-Za-z0-9._-]+$/;

// Lists messages (newest first), normalized to { Total, Unread, MessagesCount,
// Start, Messages } — the list envelope is lowercase in current Mailpit
// releases (message objects themselves stay PascalCase), and older releases
// used PascalCase, so accept either. With a search term it uses Mailpit's
// search endpoint (same shape; MessagesCount = matches, Total = whole mailbox).
async function listMessages({ limit = 50, start = 0, search = '' } = {}) {
  const l = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const s = Math.max(parseInt(start, 10) || 0, 0);
  const term = String(search || '').trim();
  const raw = term
    ? await api(`/search?query=${encodeURIComponent(term)}&limit=${l}&start=${s}`)
    : await api(`/messages?limit=${l}&start=${s}`);
  return {
    Total: raw.total ?? raw.Total ?? 0,
    Unread: raw.unread ?? raw.Unread ?? 0,
    MessagesCount: raw.messages_count ?? raw.MessagesCount ?? raw.total ?? raw.Total ?? 0,
    Start: raw.start ?? raw.Start ?? 0,
    Messages: raw.messages ?? raw.Messages ?? [],
  };
}

// Full message detail (HTML, Text, headers, attachments). Fetching a message
// also marks it read in Mailpit.
function getMessage(id) {
  if (!MESSAGE_ID_RE.test(String(id))) {
    return Promise.reject(new Error('Invalid message id.'));
  }
  return api(`/message/${encodeURIComponent(id)}`);
}

// Deletes the given messages; an empty/missing list deletes ALL messages.
function deleteMessages(ids) {
  const clean = (Array.isArray(ids) ? ids : []).filter((id) =>
    MESSAGE_ID_RE.test(String(id))
  );
  return api('/messages', { method: 'DELETE', body: { IDs: clean } });
}

function markAllRead() {
  return api('/messages', { method: 'PUT', body: { IDs: [], Read: true } });
}

module.exports = {
  UI_PORT,
  getBinPath,
  isInstalled,
  install,
  isRunning,
  isRunningAsync,
  start,
  stop,
  restart,
  getUrl,
  setCatchEnabled,
  isCatchConfigured,
  listMessages,
  getMessage,
  deleteMessages,
  markAllRead,
};
