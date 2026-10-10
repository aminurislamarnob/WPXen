'use strict';

// The client half of the protocol — the exact code the phone app imports in a
// later ticket. `WebSocket` arrives as a parameter (the `ws` client in tests,
// React Native's global on the phone), so this file never touches Node-only
// APIs: tweetnacl plus the local helpers only.

const { sealFrame, openFrame, randomNonce } = require('./frames.cjs');
const { PROTOCOL_VERSION } = require('./protocol.cjs');

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function createClient({
  url,
  WebSocket,
  keys,
  hostPublicKey,
  deviceId,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  let socket = null;
  let outCounter = 0;
  let inCounter = 0;
  let reqSeq = 0;
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

  function handleClose() {
    if (closed) return;
    closed = true;
    failAll(new Error('The connection closed.'));
    for (const cb of [...closeListeners]) {
      try {
        cb();
      } catch {}
    }
  }

  function sendOuter(outer) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected.');
    }
    socket.send(JSON.stringify(outer));
  }

  function sendSealed(payload) {
    outCounter += 1;
    const sealed = sealFrame({
      payload,
      senderSecret: keys.secretKey,
      recipientPublicKey: hostPublicKey,
      nonce: randomNonce(),
    });
    sendOuter({
      v: PROTOCOL_VERSION,
      deviceId,
      counter: outCounter,
      nonce: sealed.nonce,
      box: sealed.box,
    });
    return outCounter;
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
    inCounter = outer.counter;
    if (!payload || typeof payload !== 'object') {
      close();
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
      const subs = eventSubs.get(payload.name);
      if (!subs) return;
      for (const cb of [...subs]) {
        try {
          cb(payload.payload);
        } catch {}
      }
      return;
    }
    close();
  }

  function connect() {
    if (socket) return Promise.resolve();
    return new Promise((resolve, reject) => {
      closed = false;
      const ws = new WebSocket(url);
      const onError = (err) =>
        reject(err instanceof Error ? err : new Error('Could not connect.'));
      ws.onopen = () => {
        socket = ws;
        ws.onmessage = (event) => onSocketMessage(event.data ?? event);
        ws.onclose = handleClose;
        ws.onerror = () => {};
        for (const cb of [...openListeners]) {
          try {
            cb();
          } catch {}
        }
        resolve();
      };
      ws.onerror = onError;
    });
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
      socket?.close();
    } catch {}
    socket = null;
    handleClose();
  }

  return { connect, request, subscribe, onOpen, onClose, close };
}

module.exports = { createClient, DEFAULT_REQUEST_TIMEOUT_MS };
