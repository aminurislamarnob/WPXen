'use strict';

const http = require('http');
const net = require('net');
const { randomUUID } = require('crypto');
const {
  PROTOCOL_VERSION,
  HEALTH_PATH,
} = require('../../shared/remote-protocol/index.cjs');
const { saveSecret, loadSecret, hasSecret, clearSecret } = require('./secureSecrets.cjs');

// Remote Access tracer (spec #136, #140): a localhost HTTP server with one
// unauthenticated route, the health check. No tunnel, pairing or phone yet.
//
// Lives in the main process alongside the ptys (ADR 0001), so it works with
// the window hidden to the tray. Stays free of electron imports (resolved
// lazily nowhere — there are none) and therefore testable; electron-only
// pieces never enter this module. Tests drive the real server on an
// ephemeral port through `__setDeps` with a fake store.

// The Mac's stable identity, created once and kept in the store (never
// derived per launch, or a reboot would look like a different Mac).
const HOST_ID_KEY = 'wpxenRemoteHostId';

// The Cloudflare tunnel token, Keychain-encrypted via safeStorage. Ciphertext
// only in the store — never plaintext, never a setting, never logged.
const TOKEN_KEY = 'wpxenRemoteTunnelToken';

// Every hostname-verification failure the UI can name.
const VERIFY_REASONS = ['dns', 'connection', 'wrong-server', 'wrong-port', 'timeout'];

// How long a verification fetch may take before it counts as timed out, and
// how often the tunnel child is re-checked while it should be running.
const VERIFY_TIMEOUT_MS = 15_000;
const TUNNEL_POLL_MS = 2000;

// Deliberately not Orca's 6768, so both apps can run on the same Mac.
const DEFAULT_PORT = 6780;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

// Swapped in tests — vi.mock never reaches .cjs services (same seam as
// keepAwake.cjs). The store is injected because this module must not import
// the app's store directly (or every test would need Electron's userData).
// procman and cloudflared resolve lazily so tests that inject fakes never
// load the real modules (and their require chains) at all.
const overrides = {};
const deps = {
  get store() {
    return 'store' in overrides ? overrides.store : null;
  },
  get randomId() {
    return 'randomId' in overrides ? overrides.randomId : randomUUID;
  },
  get safeStorage() {
    return 'safeStorage' in overrides ? overrides.safeStorage : null;
  },
  get procman() {
    return 'procman' in overrides ? overrides.procman : require('./procman.cjs');
  },
  get cloudflared() {
    return 'cloudflared' in overrides
      ? overrides.cloudflared
      : require('./cloudflared.cjs');
  },
  get fetch() {
    return 'fetch' in overrides ? overrides.fetch : fetch;
  },
  get getRemoteConfig() {
    return 'getRemoteConfig' in overrides
      ? overrides.getRemoteConfig
      : () => ({ enabled: false, port: DEFAULT_PORT, hostname: '' });
  },
};

function __setDeps(next) {
  Object.assign(overrides, next);
}

// ─── State ─────────────────────────────────────────────────────────────────

let server = null; // bound http.Server, or null
let boundPort = null;
let status = { state: 'off', host: null, port: null, actualPort: null, reason: null };
// The supervised tunnel child: not-configured until Remote Access is on with
// a token saved; then starting → connected → reconnecting/error.
let tunnel = { state: 'not-configured', reason: null };
// The last hostname check: idle until there is a hostname to check.
let verification = { state: 'idle', reason: null, checkedAt: null };
const listeners = new Set();
// Each start() mints a generation; a superseded bind's late events are
// ignored rather than tearing down its replacement.
let generation = 0;
// The tunnel spec's identity (port + token generation): a changed key means
// the child must be rebuilt. The verification key adds the hostname.
let lastTunnelKey = null;
let lastSpec = null;
let lastVerifyKey = null;
let lastVerifyResult = null;
let tokenGen = 0;
let pollTimer = null;

function getStatus() {
  const store = deps.store;
  return {
    ...status,
    tokenSaved: !!store && hasSecret({ store, key: TOKEN_KEY }),
    tunnel: { ...tunnel },
    verification: { ...verification },
  };
}

function publish() {
  const snapshot = getStatus();
  for (const cb of [...listeners]) {
    try {
      cb(snapshot);
    } catch {}
  }
}

function onStatusChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// ─── Host identity ─────────────────────────────────────────────────────────

function getHostId() {
  const store = deps.store;
  if (!store) throw new Error('Remote Access needs a store before it can start');
  const existing = store.get(HOST_ID_KEY, undefined);
  if (typeof existing === 'string' && existing) return existing;
  const id = deps.randomId();
  store.set(HOST_ID_KEY, id);
  return id;
}

// ─── HTTP ──────────────────────────────────────────────────────────────────

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}

function requestHandler(req, res) {
  let url;
  try {
    url = new URL(req.url || '/', 'http://127.0.0.1');
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  if (url.pathname !== HEALTH_PATH) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    sendJson(res, 200, {
      nonce: url.searchParams.get('nonce') ?? '',
      hostId: getHostId(),
      protocolVersion: PROTOCOL_VERSION,
    });
  } catch {
    res.writeHead(500);
    res.end();
  }
}

function checkPort(port) {
  if (typeof port !== 'number' || !Number.isInteger(port)) {
    throw new Error(`Port must be a whole number between ${MIN_PORT} and ${MAX_PORT}`);
  }
  if (port !== 0 && (port < MIN_PORT || port > MAX_PORT)) {
    throw new Error(`Port must be between ${MIN_PORT} and ${MAX_PORT}`);
  }
}

// Start (or move) the server. Synchronous validation throws — a settings
// effect that calls this rejects the write, so bad values never persist.
// Binding itself is async: success and failure arrive as status updates, so
// the caller never blocks on the socket.
//
// A move binds the new port first and only closes the old server once the
// new one listens, so a failed move keeps serving where it was instead of
// dropping to nothing.
function start({ port }) {
  checkPort(port);
  getHostId();
  if (server && boundPort === port) return getStatus();

  const gen = ++generation;
  const srv = http.createServer(requestHandler);
  // WebSocket upgrades land here in a later ticket; for now every upgrade is
  // refused by dropping the socket — never a 101.
  srv.on('upgrade', (_req, socket) => {
    try {
      socket.destroy();
    } catch {}
  });
  srv.on('error', (err) => {
    if (gen !== generation) return;
    const reason =
      err && err.code === 'EADDRINUSE'
        ? `Port ${port} is in use`
        : (err && err.message) || 'The server failed to start';
    if (server) {
      // A failed move: the old server is still up, so the error rides
      // alongside it rather than replacing it.
      status = {
        state: 'error',
        host: '127.0.0.1',
        port,
        actualPort: boundPort,
        reason,
      };
    } else {
      status = { state: 'error', host: null, port, actualPort: null, reason };
    }
    publish();
  });
  srv.on('listening', () => {
    if (gen !== generation) {
      try {
        srv.close();
      } catch {}
      return;
    }
    if (server) {
      try {
        server.close();
      } catch {}
    }
    server = srv;
    boundPort = srv.address()?.port ?? port;
    status = {
      state: 'listening',
      host: '127.0.0.1',
      port,
      actualPort: boundPort,
      reason: null,
    };
    publish();
  });
  srv.listen(port, '127.0.0.1');
  return getStatus();
}

// Close the port. Idempotent: stopping what was never started is a no-op
// that still leaves the status 'off'.
function stop() {
  generation += 1;
  if (server) {
    try {
      server.close();
    } catch {}
    server = null;
    boundPort = null;
  }
  if (status.state !== 'off') {
    status = { state: 'off', host: null, port: null, actualPort: null, reason: null };
    publish();
  }
}

// ─── Tunnel token ────────────────────────────────────────────────────────
// The token is ciphertext in the store (see secureSecrets.cjs) — never a
// setting, never plaintext, never logged.

function tokenSaved() {
  const store = deps.store;
  return !!store && hasSecret({ store, key: TOKEN_KEY });
}

function loadToken() {
  const store = deps.store;
  if (!store) return null;
  return loadSecret({
    store,
    safeStorage: deps.safeStorage ?? undefined,
    key: TOKEN_KEY,
  });
}

async function setToken(value) {
  const store = deps.store;
  if (!store) throw new Error('Remote Access needs a store before it can start');
  saveSecret({
    store,
    safeStorage: deps.safeStorage ?? undefined,
    key: TOKEN_KEY,
    value,
  });
  tokenGen += 1;
  await syncTunnel();
  await maybeVerify();
}

async function clearToken() {
  const store = deps.store;
  if (store) clearSecret({ store, key: TOKEN_KEY });
  tokenGen += 1;
  await syncTunnel();
}

// ─── Supervised tunnel ───────────────────────────────────────────────────

function setTunnel(next) {
  if (JSON.stringify(next) === JSON.stringify(tunnel)) return;
  tunnel = next;
  publish();
}

function setVerification(next) {
  if (JSON.stringify(next) === JSON.stringify(verification)) return;
  verification = next;
  publish();
}

// A free loopback port for cloudflared's --metrics endpoint (the /ready
// probe). Allocated by binding port 0 and releasing it; a small race, but a
// collision just fails fast into the restart backoff.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address()?.port;
      probe.close(() => resolve(port));
    });
  });
}

async function checkTunnelReady() {
  const metricsPort = lastSpec?.meta?.metricsPort;
  if (!metricsPort) return false;
  try {
    const res = await deps.fetch(`http://127.0.0.1:${metricsPort}/ready`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// The supervised child's name lives in cloudflared.cjs (the spec builder's
// `name`), read off the injected module so tests never load the real chain.
function tunnelName() {
  return deps.cloudflared.REMOTE_TUNNEL_NAME;
}

// Bring the supervised child in line with the settings: running exactly when
// Remote Access is on with a token saved, on the configured port.
async function syncTunnel() {
  const cfg = deps.getRemoteConfig();
  const proc = deps.procman;
  if (!cfg.enabled || !tokenSaved()) {
    try {
      await proc.stop(tunnelName());
    } catch {}
    lastTunnelKey = null;
    lastSpec = null;
    setTunnel({ state: 'not-configured', reason: null });
    setVerification({ state: 'idle', reason: null, checkedAt: null });
    lastVerifyKey = null;
    return;
  }
  const cf = deps.cloudflared;
  if (!cf.isInstalled()) {
    setTunnel({
      state: 'error',
      reason: 'cloudflared is not installed. Install it below to start the tunnel.',
    });
    return;
  }
  const key = `${cfg.port}|${tokenGen}`;
  const current = proc.status(tunnelName());
  if (
    key === lastTunnelKey &&
    (current.state === 'running' || current.state === 'starting')
  ) {
    await refreshTunnelState();
    return;
  }
  let spec;
  try {
    const metricsPort = await freePort();
    const token = loadToken();
    if (!token) {
      setTunnel({ state: 'not-configured', reason: null });
      return;
    }
    spec = cf.buildRemoteTunnelSpec({
      bin: cf.getCloudflaredPath(),
      token,
      port: cfg.port,
      metricsPort,
      fetchImpl: deps.fetch,
    });
  } catch (err) {
    setTunnel({ state: 'error', reason: err?.message || 'The tunnel failed to start.' });
    return;
  }
  lastSpec = spec;
  lastTunnelKey = key;
  setTunnel({ state: 'starting', reason: null });
  try {
    await proc.start(spec);
  } catch (err) {
    setTunnel({ state: 'error', reason: err?.message || 'The tunnel failed to start.' });
    return;
  }
  await refreshTunnelState();
}

// Re-read the child and its ready probe: the poll tick, called every
// TUNNEL_POLL_MS in production and directly in tests.
async function refreshTunnelState() {
  const cfg = deps.getRemoteConfig();
  if (!cfg.enabled || !tokenSaved()) {
    setTunnel({ state: 'not-configured', reason: null });
    return { ...tunnel };
  }
  if (!deps.cloudflared.isInstalled()) {
    setTunnel({
      state: 'error',
      reason: 'cloudflared is not installed. Install it below to start the tunnel.',
    });
    return { ...tunnel };
  }
  const st = deps.procman.status(tunnelName());
  if (st.state === 'running') {
    setTunnel(
      (await checkTunnelReady())
        ? { state: 'connected', reason: null }
        : { state: 'reconnecting', reason: null }
    );
  } else if (st.state === 'starting') {
    setTunnel({ state: 'starting', reason: null });
  } else if (st.state === 'failed') {
    setTunnel({ state: 'error', reason: st.error || 'The tunnel failed.' });
  } else {
    // Stopped while still wanted: procman is converging between states.
    setTunnel({ state: 'starting', reason: null });
  }
  if (tunnel.state === 'connected') {
    await maybeVerify();
  } else if (verification.state !== 'idle') {
    setVerification({ state: 'idle', reason: null, checkedAt: null });
  }
  return { ...tunnel };
}

function startPoller() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    refreshTunnelState().catch(() => {});
  }, TUNNEL_POLL_MS);
  if (pollTimer.unref) pollTimer.unref();
}

function stopPoller() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ─── Hostname verification ───────────────────────────────────────────────
// Once the tunnel is connected, the public hostname must answer with this
// Mac's health response. Each failure maps to the distinct reason the UI
// shows, so a dashboard typo doesn't look like a dead tunnel.

function classifyFetchError(err) {
  if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) return 'timeout';
  const code = err?.cause?.code || err?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  const message = `${err?.cause?.message || ''} ${err?.message || ''}`;
  if (/ENOTFOUND|getaddrinfo|EAI_AGAIN|could not resolve|DNS/i.test(message))
    return 'dns';
  return 'connection';
}

function failVerify(key, reason) {
  lastVerifyKey = key;
  lastVerifyResult = { ok: false, reason };
  setVerification({ state: 'failed', reason, checkedAt: Date.now() });
  return lastVerifyResult;
}

async function verifyHostname() {
  const cfg = deps.getRemoteConfig();
  const hostname = (cfg.hostname || '').trim();
  if (!hostname) {
    lastVerifyKey = null;
    setVerification({ state: 'idle', reason: null, checkedAt: null });
    return { ok: false, reason: 'no-hostname' };
  }
  const key = `${hostname}|${cfg.port}|${tokenGen}`;
  const nonce = deps.randomId();
  const url = `https://${hostname}${HEALTH_PATH}?nonce=${encodeURIComponent(nonce)}`;
  setVerification({ state: 'verifying', reason: null, checkedAt: null });
  let res;
  try {
    res = await deps.fetch(url, { signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) });
  } catch (err) {
    return failVerify(key, classifyFetchError(err));
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  // Anything that isn't WPXen's health response means the route points at
  // the wrong port (or nothing WPXen at all): error pages, gateways, HTML.
  if (!res.ok || !body || typeof body !== 'object') {
    return failVerify(key, 'wrong-port');
  }
  const shapeOk =
    typeof body.nonce === 'string' &&
    typeof body.hostId === 'string' &&
    typeof body.protocolVersion === 'number';
  if (!shapeOk) return failVerify(key, 'wrong-port');
  let hostId = null;
  try {
    hostId = getHostId();
  } catch {
    hostId = null;
  }
  // Right shape but someone else's answer: a different server or Mac.
  if (
    body.nonce !== nonce ||
    body.hostId !== hostId ||
    body.protocolVersion !== PROTOCOL_VERSION
  ) {
    return failVerify(key, 'wrong-server');
  }
  lastVerifyKey = key;
  lastVerifyResult = { ok: true };
  setVerification({ state: 'ok', reason: null, checkedAt: Date.now() });
  return lastVerifyResult;
}

// Verify when the answer would be new: a changed hostname, port or token, or
// a previous check that never ran. The Check-again button calls
// verifyHostname() directly to force a fresh check.
async function maybeVerify() {
  const cfg = deps.getRemoteConfig();
  const hostname = (cfg.hostname || '').trim();
  if (!hostname) {
    lastVerifyKey = null;
    setVerification({ state: 'idle', reason: null, checkedAt: null });
    return { ok: false, reason: 'no-hostname' };
  }
  const key = `${hostname}|${cfg.port}|${tokenGen}`;
  if (
    key === lastVerifyKey &&
    (verification.state === 'ok' || verification.state === 'failed')
  ) {
    return lastVerifyResult;
  }
  return verifyHostname();
}

// Releases everything and forgets listeners. Called from before-quit; also
// resets module state for tests. The tunnel child itself stops through
// procman's quit path; here the poller and the server socket go.
function dispose() {
  stop();
  stopPoller();
  listeners.clear();
  tunnel = { state: 'not-configured', reason: null };
  verification = { state: 'idle', reason: null, checkedAt: null };
  lastTunnelKey = null;
  lastSpec = null;
  lastVerifyKey = null;
  lastVerifyResult = null;
}

module.exports = {
  HOST_ID_KEY,
  TOKEN_KEY,
  VERIFY_REASONS,
  DEFAULT_PORT,
  MIN_PORT,
  MAX_PORT,
  start,
  stop,
  getStatus,
  onStatusChange,
  setToken,
  clearToken,
  tokenSaved,
  syncTunnel,
  refreshTunnelState,
  startPoller,
  verifyHostname,
  maybeVerify,
  dispose,
  __setDeps,
};
