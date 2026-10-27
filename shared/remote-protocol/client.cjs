'use strict';

// The client half of the protocol — the exact code the phone app imports.
// `WebSocket` arrives as a parameter (the `ws` client in tests, React
// Native's global on the phone), so this file never touches Node-only APIs:
// tweetnacl plus the local helpers only.
//
// Each dial runs the v2 handshake (handshake.cjs): hello → ready → sealed
// auth frame → sealed connected event. connect() resolves only once the
// connected event opens, which proves the Mac holds the host key. Keys and
// counters belong to one connection and die with its socket.

const { PROTOCOL_VERSION, CLOSE_REVOKED } = require('./protocol.cjs');
const { createHello, completeHandshake, authPayload } = require('./handshake.cjs');

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function createClient({
  url,
  WebSocket,
  keys,
  hostPublicKey,
  deviceId,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  // The caller's CSPRNG (see keys.cjs): expo-crypto on the phone.
  randomBytes,
}) {
  let socket = null;
  // One per dial. Lets a late close from a replaced socket be recognised and
  // ignored, so reconnecting is not raced by the connection it replaced.
  let generation = 0;
  let reqSeq = 0;
  // This connection's handshake: 'hello' until the ready arrives, 'auth'
  // until the connected event opens, then 'open'. `session` is the sealed
  // channel (channelFraming.cjs) from the ready on.
  let phase = 'idle';
  let pendingHello = null;
  let session = null;
  let ready = false;
  let dialing = null; // { promise, resolve, reject } while a dial is open
  let dialSocket = null; // the socket being dialled, before it is `socket`
  const pending = new Map(); // id -> { resolve, reject, timer }
  const eventSubs = new Map(); // name -> Set(cb)
  const openListeners = new Set();
  const closeListeners = new Set();
  let closed = false;

  function failAll(err) {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      try {
        reject(err);
      } catch {}
    }
    pending.clear();
  }

  function handleClose(gen, code) {
    // A superseded socket's close arrives after the next dial already began;
    // acting on it would null the new socket and fire a spurious onClose.
    if (gen !== generation) return;
    if (closed) return;
    closed = true;
    const wasReady = ready;
    // The socket is spent, and its keys and counters with it: the next dial
    // runs a fresh handshake.
    socket = null;
    dialSocket = null;
    ready = false;
    phase = 'idle';
    pendingHello = null;
    session = null;
    failAll(new Error('The connection closed.'));
    if (dialing) {
      const { reject, timer } = dialing;
      dialing = null;
      clearTimeout(timer);
      reject(new Error('Could not connect.'));
    }
    // A dial that never came up is the caller's rejected connect(), not a
    // closed connection.
    if (!wasReady) return;
    // A revoked device reads 'revoked' here; every other close is ordinary
    // (disconnect-all reconnects, drops just end).
    const status = code === CLOSE_REVOKED ? 'revoked' : 'closed';
    for (const cb of [...closeListeners]) {
      try {
        cb(status);
      } catch {}
    }
  }

  function sendOuter(ws, outer) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected.');
    }
    ws.send(JSON.stringify(outer));
  }

  function sendSealed(payload) {
    if (!ready) throw new Error('Not connected.');
    sendOuter(socket, { v: PROTOCOL_VERSION, frame: session.seal(payload) });
  }

  function deliverEvent(name, payload) {
    const subs = eventSubs.get(name);
    if (!subs) return;
    for (const cb of [...subs]) {
      try {
        cb(payload);
      } catch {}
    }
  }

  function becomeReady(payload) {
    ready = true;
    phase = 'open';
    if (dialing) {
      const { resolve, timer } = dialing;
      dialing = null;
      clearTimeout(timer);
      resolve();
    }
    for (const cb of [...openListeners]) {
      try {
        cb();
      } catch {}
    }
    deliverEvent('connected', payload.payload);
  }

  function onSocketMessage(ws, raw) {
    let outer;
    try {
      outer = JSON.parse(String(raw));
    } catch {
      close();
      return;
    }
    if (!outer || typeof outer !== 'object' || outer.v !== PROTOCOL_VERSION) {
      close();
      return;
    }
    if (phase === 'hello') {
      session = completeHandshake({
        pending: pendingHello,
        ready: outer,
        deviceKeys: keys,
        hostPublicKey,
      });
      pendingHello = null;
      if (!session) {
        close();
        return;
      }
      phase = 'auth';
      try {
        sendOuter(ws, {
          v: PROTOCOL_VERSION,
          frame: session.seal(authPayload(deviceId)),
        });
      } catch {
        close();
      }
      return;
    }
    if (!session || typeof outer.frame !== 'string') {
      close();
      return;
    }
    // Exactly the next frame from the Mac on this connection, or the end.
    const payload = session.open(outer.frame);
    if (!payload || typeof payload !== 'object') {
      close();
      return;
    }
    if (phase === 'auth') {
      if (payload.kind !== 'event' || payload.name !== 'connected') {
        close();
        return;
      }
      becomeReady(payload);
      return;
    }
    if (payload.kind === 'response' && typeof payload.id === 'string') {
      const waiter = pending.get(payload.id);
      if (!waiter) return;
      pending.delete(payload.id);
      clearTimeout(waiter.timer);
      if (payload.error) waiter.reject(new Error(payload.error));
      else waiter.resolve(payload.result);
      return;
    }
    if (payload.kind === 'event' && typeof payload.name === 'string') {
      deliverEvent(payload.name, payload.payload);
      return;
    }
    close();
  }

  // Dials and runs the handshake, or resolves straight away when a channel
  // is up. Safe to call again after any close: the spent socket is gone and
  // the next dial derives new keys, so one client can be reconnected for the
  // life of the host.
  function connect() {
    if (socket && ready) return Promise.resolve();
    if (dialing) return dialing.promise;
    const gen = ++generation;
    closed = false;
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A Mac that accepts the socket but never completes the handshake is no
    // Mac.
    const timer = setTimeout(() => {
      if (gen !== generation || ready) return;
      try {
        ws.close();
      } catch {}
      handleClose(gen);
    }, requestTimeoutMs);
    dialing = { promise, resolve, reject, timer };
    const ws = new WebSocket(url);
    dialSocket = ws;
    ws.onopen = () => {
      // Closed while dialling: this socket was given up on before it opened.
      if (gen !== generation || closed) {
        try {
          ws.close();
        } catch {}
        return;
      }
      socket = ws;
      ws.onmessage = (event) => onSocketMessage(ws, event.data ?? event);
      ws.onerror = () => {};
      try {
        const hello = createHello({ deviceId, randomBytes });
        pendingHello = hello.pending;
        phase = 'hello';
        sendOuter(ws, hello.message);
      } catch {
        try {
          ws.close();
        } catch {}
        handleClose(gen);
      }
    };
    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener('close', (event) => handleClose(gen, event?.code));
    } else {
      ws.onclose = (event) =>
        handleClose(gen, typeof event === 'number' ? event : event?.code);
    }
    ws.onerror = () => {
      if (gen !== generation || ready) return;
      handleClose(gen);
    };
    return promise;
  }

  function request(op, params, { timeoutMs = requestTimeoutMs } = {}) {
    reqSeq += 1;
    const id = `r${reqSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('The request timed out.'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        sendSealed({ kind: 'request', id, op, params: params || {} });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  }

  function subscribe(name, cb) {
    if (!eventSubs.has(name)) eventSubs.set(name, new Set());
    eventSubs.get(name).add(cb);
    return () => eventSubs.get(name)?.delete(cb);
  }

  function onOpen(cb) {
    openListeners.add(cb);
    return () => openListeners.delete(cb);
  }

  function onClose(cb) {
    closeListeners.add(cb);
    return () => closeListeners.delete(cb);
  }

  function close() {
    try {
      (socket || dialSocket)?.close();
    } catch {}
    handleClose(generation);
  }

  return { connect, request, subscribe, onOpen, onClose, close };
}

module.exports = { createClient, DEFAULT_REQUEST_TIMEOUT_MS };
