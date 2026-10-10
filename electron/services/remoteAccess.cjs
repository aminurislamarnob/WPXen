'use strict';

const http = require('http');
const { randomUUID } = require('crypto');
const {
  PROTOCOL_VERSION,
  HEALTH_PATH,
} = require('../../shared/remote-protocol/index.cjs');

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

// Deliberately not Orca's 6768, so both apps can run on the same Mac.
const DEFAULT_PORT = 6780;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

// Swapped in tests — vi.mock never reaches .cjs services (same seam as
// keepAwake.cjs). The store is injected because this module must not import
// the app's store directly (or every test would need Electron's userData).
const overrides = {};
const deps = {
  get store() {
    return 'store' in overrides ? overrides.store : null;
  },
  get randomId() {
    return 'randomId' in overrides ? overrides.randomId : randomUUID;
  },
};

function __setDeps(next) {
  Object.assign(overrides, next);
}

// ─── State ─────────────────────────────────────────────────────────────────

let server = null; // bound http.Server, or null
let boundPort = null;
let status = { state: 'off', host: null, port: null, actualPort: null, reason: null };
const listeners = new Set();
// Each start() mints a generation; a superseded bind's late events are
// ignored rather than tearing down its replacement.
let generation = 0;

function getStatus() {
  return { ...status };
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

// Releases everything and forgets listeners. Called from before-quit; also
// resets module state for tests.
function dispose() {
  stop();
  listeners.clear();
}

module.exports = {
  HOST_ID_KEY,
  DEFAULT_PORT,
  MIN_PORT,
  MAX_PORT,
  start,
  stop,
  getStatus,
  onStatusChange,
  dispose,
  __setDeps,
};
