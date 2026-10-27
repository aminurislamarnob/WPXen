'use strict';

// The client half of the protocol — the exact code the phone app imports in a
// later ticket. `WebSocket` arrives as a parameter (the `ws` client in tests,
// React Native's global on the phone), so this file never touches Node-only
// APIs: tweetnacl plus the local helpers only.

const { sealFrame, openFrame, randomNonce } = require('./frames.cjs');
const { encodeBase64 } = require('./base64.cjs');
const { PROTOCOL_VERSION, CLOSE_REVOKED } = require('./protocol.cjs');

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
  let outCounter = 0;
  let inCounter = 0;
  let reqSeq = 0;
  // This connection's binding (see frames.cjs): our nonce goes out in the
  // hello, the Mac's comes back in `ch` on its first frame. Until then the
  // channel isn't ready and connect() hasn't resolved.
  let clientNonce = null;
  let channel = null;
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
    // The socket is spent: drop it so connect() dials a new one instead of
    // short-circuiting on a stale reference, and reset the counters the way
    // the server does — it counts from 1 per connection, so a reconnect that
    // resumed at N+1 would have every frame dropped.
    socket = null;
    dialSocket = null;
    ready = false;
    channel = null;
    clientNonce = null;
    outCounter = 0;
    inCounter = 0;
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

  function sealAndSend(ws, payload) {
    outCounter += 1;
    const sealed = sealFrame({
      payload: { ...payload, n: outCounter },
      senderSecret: keys.secretKey,
      recipientPublicKey: hostPublicKey,
      nonce: randomNonce(randomBytes),
    });
    sendOuter(ws, {
      v: PROTOCOL_VERSION,
      deviceId,
      counter: outCounter,
      nonce: sealed.nonce,
      box: sealed.box,
    });
  }

  function sendSealed(payload) {
    if (!ready) throw new Error('Not connected.');
    sealAndSend(socket, { ...payload, ch: channel });
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

  function onSocketMessage(raw) {
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
    if (typeof outer.counter !== 'number' || outer.counter !== inCounter + 1) {
      close();
      return;
    }
    let payload;
    try {
      payload = openFrame({
        nonce: outer.nonce,
        box: outer.box,
        senderPublicKey: hostPublicKey,
        recipientSecret: keys.secretKey,
      });
    } catch {
      close();
      return;
    }
    // The sealed counter is the one that counts: the envelope's is plaintext.
    if (!payload || typeof payload !== 'object' || payload.n !== outer.counter) {
      close();
      return;
    }
    if (!ready) {
      // The Mac's first frame names the channel: our nonce, then its own.
      if (
        payload.kind !== 'event' ||
        payload.name !== 'connected' ||
        typeof payload.ch !== 'string' ||
        !payload.ch.startsWith(`${clientNonce}.`) ||
        payload.ch.length <= clientNonce.length + 1
      ) {
        close();
        return;
      }
      inCounter = outer.counter;
      channel = payload.ch;
      ready = true;
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
      return;
    }
    if (payload.ch !== channel) {
      close();
      return;
    }
    inCounter = outer.counter;
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

  // Dials and binds a channel, or resolves straight away when one is up.
  // Safe to call again after any close: the spent socket is gone and the
  // counters restart, so one client can be reconnected for the life of the
  // host.
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
    // A Mac that accepts the socket but never names the channel is no Mac.
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
      ws.onmessage = (event) => onSocketMessage(event.data ?? event);
      ws.onerror = () => {};
      clientNonce = encodeBase64(randomNonce(randomBytes));
      try {
        sealAndSend(ws, { kind: 'hello', clientNonce });
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
