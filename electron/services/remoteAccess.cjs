'use strict';

const http = require('http');
const net = require('net');
const { randomUUID, randomBytes } = require('crypto');
const {
  PROTOCOL_VERSION,
  HEALTH_PATH,
  DEVICE_PATH,
  confirmationCode,
  pairingUrl,
  sealFrame,
  openFrame,
  randomNonce,
  PAIR_ERRORS,
  CLOSE_REVOKED,
  CLOSE_DISCONNECT_ALL,
  newKeyPair,
  keyPairFromSecret,
  publicKeyB64,
  encodeBase64,
  decodeBase64,
} = require('../../shared/remote-protocol/index.cjs');
const QRCode = require('qrcode');
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

// The Mac's long-term box keypair, Keychain-encrypted via safeStorage. Only
// the secret half is stored (base64); the public half is derived from it on
// every launch (after Orca e2ee-keypair.ts) — advertising a stored public key
// that disagrees with the secret would offer a key no listener holds, and
// silently regenerating would un-pair every device.
const HOST_KEY_KEY = 'wpxenRemoteHostKey';

// Paired devices: [{ id, name, platform, publicKey, pairedAt, lastSeen }].
const DEVICE_KEY = 'wpxenRemoteDevices';
// Last seen writes at most once a minute per device: a store write per frame
// would churn the disk for no visible gain.
const LAST_SEEN_MIN_MS = 60_000;

// A pairing offer lives 5 minutes and works once: on use, on Deny and on
// expiry it dies. Hitting the pairing rate limit kills it too.
const OFFER_TTL_MS = 5 * 60 * 1000;
// The Allow/Deny dialog waits 2 minutes, then the phone gets pairing_timeout.
const PAIR_PROMPT_TIMEOUT_MS = 2 * 60 * 1000;
// A fresh socket that never speaks the protocol is closed.
const HANDSHAKE_TIMEOUT_MS = 10_000;
// Failed pairing attempts (wrong secret, bad proof) are rate-limited per
// remote address and globally; tripping either invalidates the offer.
const PAIR_WINDOW_MS = 10 * 60 * 1000;
const PAIR_MAX_PER_IP = 5;
const PAIR_MAX_GLOBAL = 20;

// The only phone-reachable operations in this ticket (after Orca's
// mobile-method-allowlist pattern): ping proves the channel end to end.
// Later tickets grow this set; anything else gets op_not_allowed.
const ALLOWED_OPS = new Set([
  'ping',
  'projects.list',
  'sessions.list',
  'sessions.markRead',
]);

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
  get now() {
    return 'now' in overrides ? overrides.now : Date.now;
  },
  get pairTimeoutMs() {
    return 'pairTimeoutMs' in overrides
      ? overrides.pairTimeoutMs
      : PAIR_PROMPT_TIMEOUT_MS;
  },
  // The Allow/Deny dialog. Defaults to denying: no human, no pairing.
  get promptPairing() {
    return 'promptPairing' in overrides ? overrides.promptPairing : async () => 'deny';
  },
  get onPaired() {
    return 'onPaired' in overrides ? overrides.onPaired : () => {};
  },
  get getRemoteConfig() {
    return 'getRemoteConfig' in overrides
      ? overrides.getRemoteConfig
      : () => ({ enabled: false, port: DEFAULT_PORT, hostname: '' });
  },
  // The Session engine, narrowed to what the phone may reach (injected from
  // ipc.cjs; safe no-op defaults keep unit tests light).
  get sessions() {
    if ('sessions' in overrides) return overrides.sessions;
    return {
      list: () => [],
      subscribe: () => () => {},
      markRead: () => {},
      get: () => null,
      projects: () => [],
    };
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
// The live pairing offer ({ secret, expiresAt }) or null. `offerConsumed`
// remembers a spent offer so reuse reports pairing_used rather than expired.
let offer = null;
let offerConsumed = false;
// Pairing-failure buckets: ip -> { count, resetAt }, plus a global one.
const failuresByIp = new Map();
let globalFailures = { count: 0, resetAt: 0 };
// The WebSocket server shares the localhost HTTP server's port (one `ws`
// instance for every bound server, created lazily).
let wss = null;

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
  // Device upgrades (wss://…/wpxen-device) ride the WebSocket server; every
  // other upgrade is refused by dropping the socket — never a 101.
  srv.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    } catch {}
    if (pathname !== DEVICE_PATH) {
      try {
        socket.destroy();
      } catch {}
      return;
    }
    wsServer().handleUpgrade(req, socket, head, (ws) =>
      wsServer().emit('connection', ws, req)
    );
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

// ─── Host keypair ────────────────────────────────────────────────────────

function getHostKeypair() {
  const store = deps.store;
  if (!store) throw new Error('Remote Access needs a store before it can start');
  const raw = store.get(HOST_KEY_KEY, undefined);
  if (typeof raw === 'string' && raw) {
    let secret = null;
    try {
      const b64 = loadSecret({
        store,
        safeStorage: deps.safeStorage ?? undefined,
        key: HOST_KEY_KEY,
      });
      if (typeof b64 === 'string' && b64) secret = decodeBase64(b64);
    } catch {
      secret = null;
    }
    // A stored key that no longer decrypts is surfaced, never silently
    // replaced: regenerating would un-pair every device (after Orca
    // e2ee-keypair.ts).
    if (!secret || secret.length !== 32) {
      throw new Error('The stored host key is unreadable. Remove it and pair again.');
    }
    return keyPairFromSecret(secret);
  }
  const pair = newKeyPair();
  saveSecret({
    store,
    safeStorage: deps.safeStorage ?? undefined,
    key: HOST_KEY_KEY,
    value: encodeBase64(pair.secretKey),
  });
  return pair;
}

// ─── Pairing offer ───────────────────────────────────────────────────────

function offerProblem() {
  if (offerConsumed) return 'used';
  if (!offer) return 'expired';
  if (deps.now() > offer.expiresAt) {
    offer = null;
    return 'expired';
  }
  return null;
}

function consumeOffer() {
  offer = null;
  offerConsumed = true;
}

// Render the QR the phone scans (after Orca mobile-pairing-qr.ts:
// error correction M, quiet zone 4). The renderer shows the data URL in an
// <img> and never sees the secret itself.
async function offerQr(url) {
  try {
    return await QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 4,
      scale: 2,
    });
  } catch {
    throw new Error('Could not render the QR code.');
  }
}

async function pairingOffer({ hostname }) {
  if (!server) throw new Error('Remote Access must be on to pair a device.');
  const host = (hostname || '').trim();
  if (!host) throw new Error('Set a public hostname before pairing.');
  const keypair = getHostKeypair();
  const secret = randomBytes(16).toString('hex');
  offer = { secret, expiresAt: deps.now() + OFFER_TTL_MS };
  offerConsumed = false;
  const url = pairingUrl({
    version: PROTOCOL_VERSION,
    hostId: getHostId(),
    hostPublicKeyB64: publicKeyB64(keypair),
    secret,
    wssUrl: `wss://${host}${DEVICE_PATH}`,
  });
  return { url, qr: await offerQr(url), expiresAt: offer.expiresAt };
}

// ─── Device registry ─────────────────────────────────────────────────────

// Live channels by device id. Each entry carries its socket plus its sealed
// sender (counters live per connection), so pushes fan out without lookups.
// The source of the connected-now indicator; revoking or disconnecting closes
// these first.
const deviceSockets = new Map(); // deviceId -> Set({ ws, send })
const deviceListeners = new Set();

function readDeviceRecords() {
  const store = deps.store;
  if (!store) return [];
  const all = store.get(DEVICE_KEY, []);
  return Array.isArray(all) ? all : [];
}

// The Settings → Mobile rows: the record plus whether a socket is live now.
function listDevices() {
  return readDeviceRecords()
    .filter((d) => d && typeof d.id === 'string')
    .map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      pairedAt: d.pairedAt,
      lastSeen: d.lastSeen,
      connected: (deviceSockets.get(d.id)?.size || 0) > 0,
    }));
}

function publishDevices() {
  const snapshot = listDevices();
  for (const cb of [...deviceListeners]) {
    try {
      cb(snapshot);
    } catch {}
  }
}

function onDevicesChanged(cb) {
  deviceListeners.add(cb);
  return () => deviceListeners.delete(cb);
}

function findDevice(id) {
  return readDeviceRecords().find((d) => d && d.id === id) || null;
}

function saveDevice(record) {
  deps.store.set(DEVICE_KEY, [...readDeviceRecords(), record]);
  publishDevices();
}

function touchDevice(id) {
  const store = deps.store;
  if (!store) return;
  const t = deps.now();
  let wrote = false;
  store.set(
    DEVICE_KEY,
    readDeviceRecords().map((d) => {
      if (!d || d.id !== id) return d;
      if (d.lastSeen && t - d.lastSeen < LAST_SEEN_MIN_MS) return d;
      wrote = true;
      return { ...d, lastSeen: t };
    })
  );
  if (wrote) publishDevices();
}

function trackChannel(id, entry) {
  if (!deviceSockets.has(id)) deviceSockets.set(id, new Set());
  deviceSockets.get(id).add(entry);
  entry.ws.on('close', () => {
    const set = deviceSockets.get(id);
    if (!set) return;
    set.delete(entry);
    if (set.size === 0) deviceSockets.delete(id);
    publishDevices();
  });
  publishDevices();
}

// Rename is a local label only; the phone keeps its own name.
async function renameDevice(id, name) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Enter a device name.');
  if (clean.length > 100) throw new Error('Keep the device name under 100 characters.');
  const store = deps.store;
  if (!store) throw new Error('Remote Access needs a store before it can start');
  const records = readDeviceRecords();
  if (!records.some((d) => d && d.id === id)) throw new Error('Unknown device.');
  store.set(
    DEVICE_KEY,
    records.map((d) => (d && d.id === id ? { ...d, name: clean } : d))
  );
  publishDevices();
  return { ok: true };
}

// Revoke deletes the record (push fields die with it — they are empty until
// the push ticket) and closes every live socket at once with the revoked
// code, so the phone can say it was removed. The next connect fails exactly
// like an unknown device: closed, no reply.
async function revokeDevice(id) {
  const store = deps.store;
  if (!store) throw new Error('Remote Access needs a store before it can start');
  if (!readDeviceRecords().some((d) => d && d.id === id))
    throw new Error('Unknown device.');
  const sockets = deviceSockets.get(id);
  if (sockets) {
    for (const entry of [...sockets]) {
      try {
        entry.ws.close(CLOSE_REVOKED, 'revoked');
      } catch {}
    }
    deviceSockets.delete(id);
  }
  store.set(
    DEVICE_KEY,
    readDeviceRecords().filter((d) => !d || d.id !== id)
  );
  publishDevices();
  return { ok: true };
}

// Drop every live socket. Records are kept, so the devices reconnect.
async function disconnectAll() {
  for (const [id, entries] of [...deviceSockets.entries()]) {
    for (const entry of [...entries]) {
      try {
        entry.ws.close(CLOSE_DISCONNECT_ALL, 'disconnecting');
      } catch {}
    }
    deviceSockets.delete(id);
  }
  publishDevices();
  return { ok: true };
}

// ─── Sessions for the phone ──────────────────────────────────────────────
// The Session engine is read here, never changed. The narrow `sessions` dep
// (list/subscribe/markRead/get/projects, injected from ipc.cjs like
// keepAwake.watchSessions) keeps this module's tests light.

// Pushes coalesce to a few per second: a burst of pty output must not flood
// the socket.
const SESSIONS_PUSH_MS = 250;
let sessionsPushTimer = null;
let sessionsUnsub = null;

function ensureSessionsFeed() {
  if (sessionsUnsub) return;
  try {
    sessionsUnsub = deps.sessions.subscribe(() => scheduleSessionsPush());
  } catch {
    sessionsUnsub = null;
  }
}

function scheduleSessionsPush() {
  if (sessionsPushTimer) return;
  sessionsPushTimer = setTimeout(() => {
    sessionsPushTimer = null;
    pushSessionsChanged();
  }, SESSIONS_PUSH_MS);
  if (sessionsPushTimer.unref) sessionsPushTimer.unref();
}

function pushSessionsChanged() {
  let rows;
  try {
    rows = phoneSessionRows();
  } catch {
    return;
  }
  for (const entries of deviceSockets.values()) {
    for (const entry of [...entries]) {
      try {
        entry.send({
          kind: 'event',
          name: 'sessions.changed',
          payload: { sessions: rows },
        });
      } catch {}
    }
  }
}

// The phone-safe row: an allowlist of fields, never a blocklist. Local
// filesystem paths, handoff files and environment stay in this process.
function phoneSessionRow(row) {
  let hasTranscript = false;
  try {
    const session = deps.sessions.get(row.sessionId);
    const transcripts = require('./transcripts.cjs');
    hasTranscript =
      !!session &&
      !!transcripts.locateTranscript({
        agentId: row.agentId,
        cwd: session.cwd,
        startedAt: row.startedAt,
      });
  } catch {
    hasTranscript = false;
  }
  return {
    sessionId: row.sessionId,
    projectId: row.siteId,
    agentId: row.agentId,
    agentName: row.agentName,
    label: row.label,
    title: row.title,
    state: row.state,
    unread: row.unread,
    exited: row.exited,
    exitCode: row.exitCode,
    startedAt: row.startedAt,
    changedAt: row.changedAt,
    paneOf: row.paneOf,
    hasTranscript,
  };
}

function phoneSessionRows() {
  return deps.sessions.list().map(phoneSessionRow);
}

function phoneProjects() {
  return deps.sessions.projects().map((p) => ({ id: p.id, name: p.name, kind: p.kind }));
}

async function dispatchSessionOp(op, params) {
  if (op === 'projects.list') {
    return { projects: phoneProjects() };
  }
  if (op === 'sessions.list') {
    return { sessions: phoneSessionRows() };
  }
  if (op === 'sessions.markRead') {
    const sessionId = params && params.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('Unknown session.');
    if (!deps.sessions.get(sessionId)) throw new Error('Unknown session.');
    deps.sessions.markRead(sessionId);
    return { ok: true };
  }
  throw new Error(`Unknown operation: ${op}`);
}

// ─── Pairing rate limiting ───────────────────────────────────────────────

function failureBucket(map, key) {
  const t = deps.now();
  let bucket = map.get(key);
  if (!bucket || t > bucket.resetAt) {
    bucket = { count: 0, resetAt: t + PAIR_WINDOW_MS };
    map.set(key, bucket);
  }
  return bucket;
}

function pairingLimited(ip) {
  const t = deps.now();
  if (t > globalFailures.resetAt)
    globalFailures = { count: 0, resetAt: t + PAIR_WINDOW_MS };
  const bucket = failureBucket(failuresByIp, ip);
  return bucket.count >= PAIR_MAX_PER_IP || globalFailures.count >= PAIR_MAX_GLOBAL;
}

function recordPairFailure(ip) {
  const bucket = failureBucket(failuresByIp, ip);
  bucket.count += 1;
  if (deps.now() > globalFailures.resetAt) {
    globalFailures = { count: 0, resetAt: deps.now() + PAIR_WINDOW_MS };
  }
  globalFailures.count += 1;
  const limited =
    bucket.count > PAIR_MAX_PER_IP || globalFailures.count > PAIR_MAX_GLOBAL;
  if (limited) offer = null;
  return limited;
}

// ─── Device channel ──────────────────────────────────────────────────────

function wsServer() {
  if (!wss) {
    const { WebSocketServer } = require('ws');
    wss = new WebSocketServer({ noServer: true });
    wss.on('connection', handleDeviceConnection);
  }
  return wss;
}

function sendWs(ws, obj) {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  } catch {}
}

function drop(ws) {
  try {
    ws.close();
  } catch {}
}

function handleDeviceConnection(ws, req) {
  const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  let device = null; // set once a sealed frame (or accept) authenticates us
  let devicePublicKey = null;
  let inCounter = 0;
  let outCounter = 0;
  const keypair = getHostKeypair();

  const firstTimer = setTimeout(drop, HANDSHAKE_TIMEOUT_MS, ws);
  ws.on('close', () => clearTimeout(firstTimer));

  function sendSealed(payload) {
    outCounter += 1;
    const sealed = sealFrame({
      payload,
      senderSecret: keypair.secretKey,
      recipientPublicKey: devicePublicKey,
      nonce: randomNonce(),
    });
    sendWs(ws, {
      v: PROTOCOL_VERSION,
      counter: outCounter,
      nonce: sealed.nonce,
      box: sealed.box,
    });
  }

  function welcome() {
    touchDevice(device.id);
    sendSealed({ kind: 'event', name: 'connected', payload: { deviceId: device.id } });
  }

  function onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return drop(ws);
    }
    if (!msg || typeof msg !== 'object') return drop(ws);
    clearTimeout(firstTimer);
    if (!device && msg.type === 'pair-request') {
      handlePair(msg).catch(() => {
        try {
          drop(ws);
        } catch {}
      });
      return;
    }
    handleFrame(msg);
  }

  async function handlePair(msg) {
    const reject = (reason, extra) => {
      sendWs(ws, { type: 'pair-reject', reason, ...extra });
      drop(ws);
    };
    if (msg.v !== PROTOCOL_VERSION) {
      return reject(PAIR_ERRORS.versionMismatch, {
        update: msg.v > PROTOCOL_VERSION ? 'desktop' : 'phone',
      });
    }
    if (pairingLimited(ip)) {
      offer = null;
      return reject(PAIR_ERRORS.rateLimited);
    }
    const problem = offerProblem();
    if (problem === 'used') return reject(PAIR_ERRORS.pairingUsed);
    if (problem === 'expired') return reject(PAIR_ERRORS.pairingExpired);
    let deviceKey;
    try {
      deviceKey = decodeBase64(msg.devicePublicKey);
      if (deviceKey.length !== 32) throw new Error('bad key');
    } catch {
      if (recordPairFailure(ip)) return reject(PAIR_ERRORS.rateLimited);
      return reject(PAIR_ERRORS.invalidSecret);
    }
    let payload;
    try {
      payload = openFrame({
        nonce: msg.nonce,
        box: msg.box,
        senderPublicKey: deviceKey,
        recipientSecret: keypair.secretKey,
      });
    } catch {
      if (recordPairFailure(ip)) return reject(PAIR_ERRORS.rateLimited);
      return reject(PAIR_ERRORS.invalidSecret);
    }
    if (!payload || payload.kind !== 'pair-request' || payload.secret !== offer.secret) {
      if (recordPairFailure(ip)) return reject(PAIR_ERRORS.rateLimited);
      return reject(PAIR_ERRORS.invalidSecret);
    }
    const hostB64 = publicKeyB64(keypair);
    const code = confirmationCode(hostB64, msg.devicePublicKey, offer.secret);
    let answer;
    try {
      answer = await Promise.race([
        Promise.resolve()
          .then(() =>
            deps.promptPairing({
              deviceName: payload.deviceName,
              platform: payload.platform,
              code,
            })
          )
          .then(
            (v) => v,
            () => 'deny'
          ),
        new Promise((_, rejectTimeout) =>
          setTimeout(
            () => rejectTimeout(new Error('pairing prompt timed out')),
            deps.pairTimeoutMs
          )
        ),
      ]);
    } catch {
      consumeOffer();
      return reject(PAIR_ERRORS.pairingTimeout);
    }
    if (answer !== 'allow') {
      consumeOffer();
      return reject(PAIR_ERRORS.pairingDenied);
    }
    const deviceId = randomUUID();
    saveDevice({
      id: deviceId,
      name: String(payload.deviceName || 'Phone'),
      platform: String(payload.platform || ''),
      publicKey: msg.devicePublicKey,
      pairedAt: deps.now(),
      lastSeen: deps.now(),
    });
    consumeOffer();
    const sealed = sealFrame({
      payload: { kind: 'pair-accept', deviceId, code },
      senderSecret: keypair.secretKey,
      recipientPublicKey: deviceKey,
      nonce: randomNonce(),
    });
    sendWs(ws, {
      type: 'pair-accept',
      deviceId,
      code,
      nonce: sealed.nonce,
      box: sealed.box,
    });
    try {
      deps.onPaired({ name: String(payload.deviceName || 'Phone') });
    } catch {}
    // The pairing socket stays up as this device's channel: counters start
    // fresh, and the welcome event is its first sealed frame.
    device = findDevice(deviceId);
    devicePublicKey = deviceKey;
    inCounter = 0;
    outCounter = 0;
    trackChannel(deviceId, { ws, send: sendSealed });
    ensureSessionsFeed();
    welcome();
  }

  function handleFrame(msg) {
    handleFrameAsync(msg).catch(() => drop(ws));
  }

  async function handleFrameAsync(msg) {
    if (msg.v !== PROTOCOL_VERSION) return drop(ws);
    const known = device || findDevice(msg.deviceId);
    // Unknown ids are dropped with no reply — the response never reveals
    // whether the id or the key was wrong.
    if (!known) return drop(ws);
    if (!device) {
      device = known;
      try {
        devicePublicKey = decodeBase64(known.publicKey);
      } catch {
        return drop(ws);
      }
      trackChannel(device.id, { ws, send: sendSealed });
      ensureSessionsFeed();
      welcome();
    }
    if (typeof msg.counter !== 'number' || msg.counter !== inCounter + 1) return drop(ws);
    let payload;
    try {
      payload = openFrame({
        nonce: msg.nonce,
        box: msg.box,
        senderPublicKey: devicePublicKey,
        recipientSecret: keypair.secretKey,
      });
    } catch {
      return drop(ws);
    }
    inCounter = msg.counter;
    touchDevice(device.id);
    if (!payload || payload.kind !== 'request' || typeof payload.id !== 'string')
      return drop(ws);
    if (!ALLOWED_OPS.has(payload.op)) {
      return sendSealed({
        kind: 'response',
        id: payload.id,
        error: PAIR_ERRORS.opNotAllowed,
      });
    }
    if (payload.op === 'ping') {
      return sendSealed({
        kind: 'response',
        id: payload.id,
        result: { pong: true, serverTime: deps.now() },
      });
    }
    try {
      const result = await dispatchSessionOp(payload.op, payload.params);
      return sendSealed({ kind: 'response', id: payload.id, result });
    } catch (err) {
      return sendSealed({
        kind: 'response',
        id: payload.id,
        error: err?.message || 'Failed.',
      });
    }
  }

  ws.on('message', onMessage);
}

// Releases everything and forgets listeners. Called from before-quit; also
// resets module state for tests. The tunnel child itself stops through
// procman's quit path; here the poller and the server socket go.
function dispose() {
  stop();
  stopPoller();
  if (sessionsPushTimer) {
    clearTimeout(sessionsPushTimer);
    sessionsPushTimer = null;
  }
  if (sessionsUnsub) {
    try {
      sessionsUnsub();
    } catch {}
    sessionsUnsub = null;
  }
  for (const entries of deviceSockets.values()) {
    for (const entry of [...entries]) {
      try {
        entry.ws.close();
      } catch {}
    }
  }
  deviceSockets.clear();
  listeners.clear();
  deviceListeners.clear();
  tunnel = { state: 'not-configured', reason: null };
  verification = { state: 'idle', reason: null, checkedAt: null };
  lastTunnelKey = null;
  lastSpec = null;
  lastVerifyKey = null;
  lastVerifyResult = null;
  offer = null;
  offerConsumed = false;
  failuresByIp.clear();
  globalFailures = { count: 0, resetAt: 0 };
}

module.exports = {
  HOST_ID_KEY,
  HOST_KEY_KEY,
  DEVICE_KEY,
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
  pairingOffer,
  listDevices,
  onDevicesChanged,
  renameDevice,
  revokeDevice,
  disconnectAll,
  dispose,
  __setDeps,
};
