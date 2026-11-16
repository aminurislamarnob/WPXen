'use strict';

// ── Session Host client (#230) ───────────────────────────────────────────────
// Connects to a Session Host over its Unix domain socket and exposes the same
// terminal-provider shape (start, write, resize, stop, attach, clearBuffer,
// getPid, onOutput, onExit) plus host-level `hello`, `list` and `close`.
//
// Electron-free: loads under plain Node.

const net = require('net');
const { StringDecoder } = require('string_decoder');
const { PROTOCOL_VERSION, parseHostMessage } = require('./sessionHost.cjs');

// An attach reply carries up to 5 MB of history, and JSON turns each ESC into
// six characters, so a reply line can reach ~30 MB. Dropping it would leave
// the attach waiting for ever.
const MAX_LINE_BYTES = 64 * 1024 * 1024;
// No request may wait for ever on a host that accepted the connection but
// stopped answering: the app's launch waits on these.
const REQUEST_TIMEOUT_MS = 30 * 1000;
const HELLO_TIMEOUT_MS = 5 * 1000;
const CLOSE_TIMEOUT_MS = 2 * 1000;

function createSessionHostClient({
  socketPath,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  helloTimeoutMs = HELLO_TIMEOUT_MS,
} = {}) {
  if (!socketPath) throw new Error('socketPath is required');

  let conn = null;
  let connecting = null;
  let nextId = 1;
  let helloInfo = null;
  const pending = new Map(); // id -> { resolve, reject }
  const pids = new Map(); // sessionId -> pid
  const exitedSessions = new Set();
  const outputListeners = new Set();
  const exitListeners = new Set();
  const statusListeners = new Set();
  const disconnectListeners = new Set();

  function onOutput(cb) {
    outputListeners.add(cb);
    return () => outputListeners.delete(cb);
  }

  function onExit(cb) {
    exitListeners.add(cb);
    return () => exitListeners.delete(cb);
  }

  function onStatus(cb) {
    statusListeners.add(cb);
    return () => statusListeners.delete(cb);
  }

  function onDisconnect(cb) {
    disconnectListeners.add(cb);
    return () => disconnectListeners.delete(cb);
  }

  // Returns true when an RPC response settled a pending promise.
  function handleLine(line) {
    const parsed = parseHostMessage(line);
    if (!parsed.ok) return false;
    const msg = parsed.message;

    if (parsed.kind === 'event') {
      if (msg.type === 'output') {
        if (exitedSessions.has(msg.sessionId)) return false;
        for (const cb of outputListeners) {
          try {
            cb({ sessionId: msg.sessionId, data: msg.data });
          } catch {}
        }
      } else if (msg.type === 'status') {
        for (const cb of statusListeners) {
          try {
            cb({
              sessionId: msg.sessionId,
              state: msg.state,
              title: msg.title,
              changedAt: msg.changedAt,
              unread: msg.unread,
            });
          } catch {}
        }
      } else if (msg.type === 'exit') {
        if (exitedSessions.has(msg.sessionId)) return false;
        exitedSessions.add(msg.sessionId);
        for (const cb of exitListeners) {
          try {
            cb({ sessionId: msg.sessionId, exitCode: msg.exitCode ?? 0 });
          } catch {}
        }
      }
      return false;
    }

    const entry = pending.get(msg.id);
    if (!entry) return false;
    pending.delete(msg.id);
    if (entry.timer) clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg);
    else entry.reject(new Error(msg.error || 'Session Host request failed'));
    return true;
  }

  function failAllPending(err) {
    for (const { reject, timer } of pending.values()) {
      if (timer) clearTimeout(timer);
      try {
        reject(err);
      } catch {}
    }
    pending.clear();
  }

  function ensureConnected() {
    if (conn && !conn.destroyed) return Promise.resolve(conn);
    if (connecting) return connecting;

    connecting = new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      const decoder = new StringDecoder('utf8');
      let buf = '';
      let settled = false;
      let gone = false;

      socket.once('connect', () => {
        settled = true;
        conn = socket;
        connecting = null;
        resolve(socket);
      });

      const lineQueue = [];
      let draining = false;
      async function drainLines() {
        draining = true;
        try {
          while (lineQueue.length > 0) {
            const line = lineQueue.shift();
            if (handleLine(line)) {
              // Yield a handful of microtasks so chained promise handlers
              // (e.g. `attach()` binding `session.window`) settle before
              // subsequent events packed into the same socket read run.
              for (let i = 0; i < 4; i++) await Promise.resolve();
            }
          }
        } finally {
          draining = false;
        }
      }

      socket.on('data', (chunk) => {
        buf += decoder.write(chunk);
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.trim()) lineQueue.push(line);
        }
        if (buf.length > MAX_LINE_BYTES) {
          // Past the limit the line can't be framed any more; fail whatever
          // waits on it rather than hang.
          buf = '';
          failAllPending(new Error('Session Host reply too large'));
        }
        if (lineQueue.length > 0 && !draining) void drainLines();
      });

      // 'error' is followed by 'close'; listeners hear one disconnect.
      const onGone = (err) => {
        if (gone) return;
        gone = true;
        if (!settled) {
          settled = true;
          connecting = null;
          reject(err || new Error('Failed to connect to Session Host'));
          return;
        }
        if (conn === socket) conn = null;
        failAllPending(err || new Error('Session Host disconnected'));
        for (const cb of disconnectListeners) {
          try {
            cb();
          } catch {}
        }
      };

      socket.once('error', onGone);
      socket.once('close', () => onGone(new Error('Session Host closed connection')));
    });

    return connecting;
  }

  function sendOnSocket(socket, type, payload, timeoutMs) {
    const id = nextId++;
    const line = JSON.stringify({ v: PROTOCOL_VERSION, id, type, ...payload }) + '\n';
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (pending.get(id) !== entry) return;
          pending.delete(id);
          reject(new Error(`Session Host did not answer “${type}” in time`));
        }, timeoutMs);
        entry.timer.unref?.();
      }
      pending.set(id, entry);
      socket.write(line, (err) => {
        if (err && pending.get(id) === entry) {
          pending.delete(id);
          if (entry.timer) clearTimeout(entry.timer);
          reject(err);
        }
      });
    });
  }

  function request(type, payload = {}, { timeoutMs = requestTimeoutMs } = {}) {
    if (conn && !conn.destroyed) {
      return sendOnSocket(conn, type, payload, timeoutMs);
    }
    return ensureConnected().then((socket) =>
      sendOnSocket(socket, type, payload, timeoutMs)
    );
  }

  async function hello() {
    const res = await request('hello', {}, { timeoutMs: helloTimeoutMs });
    helloInfo = res;
    return res;
  }

  function supports(capability) {
    if (!helloInfo) return true;
    return (
      Array.isArray(helloInfo.capabilities) && helloInfo.capabilities.includes(capability)
    );
  }

  async function list() {
    const res = await request('list');
    for (const s of res.sessions || []) {
      if (s.pid) pids.set(s.sessionId, s.pid);
      if (s.exited) exitedSessions.add(s.sessionId);
    }
    return res.sessions || [];
  }

  async function start(opts = {}) {
    exitedSessions.delete(opts.sessionId);
    const res = await request('start', {
      sessionId: opts.sessionId,
      file: opts.file,
      args: opts.args || [],
      cwd: opts.cwd,
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      env: opts.env || {},
      name: opts.name || 'xterm-256color',
      agent: opts.agent !== false,
    });
    if (res.pid != null) pids.set(opts.sessionId, res.pid);
    return { sessionId: res.sessionId, pid: res.pid };
  }

  async function write(sessionId, data) {
    if (exitedSessions.has(sessionId)) return;
    await request('write', { sessionId, data });
  }

  async function resize(sessionId, cols, rows) {
    if (exitedSessions.has(sessionId) || !(cols > 0 && rows > 0)) return;
    await request('resize', { sessionId, cols, rows });
  }

  async function attach(sessionId) {
    const res = await request('attach', { sessionId });
    if (res.exited) exitedSessions.add(sessionId);
    return {
      sessionId: res.sessionId,
      data: res.data || '',
      exited: !!res.exited,
      exitCode: res.exitCode ?? null,
      state: res.state,
      title: res.title,
      changedAt: res.changedAt,
      unread: res.unread,
    };
  }

  async function markRead(sessionId, read = true) {
    if (!supports('mark-read')) return;
    await request('mark-read', { sessionId, read: !!read });
  }

  async function clearBuffer(sessionId) {
    await request('clear-buffer', { sessionId });
  }

  // `keepHistory` asks the host to keep the Session's history file for its
  // ended row. Hosts without 'stop-keep-history' ignore the field.
  async function stop(sessionId, { keepHistory = false } = {}) {
    pids.delete(sessionId);
    await request(
      'stop',
      keepHistory && supports('stop-keep-history')
        ? { sessionId, keepHistory: true }
        : { sessionId }
    );
  }

  function getPid(sessionId) {
    return pids.get(sessionId) ?? null;
  }

  function close() {
    return new Promise((resolve) => {
      if (!conn || conn.destroyed) {
        conn = null;
        return resolve();
      }
      const s = conn;
      conn = null;
      const t = setTimeout(() => {
        s.destroy();
        resolve();
      }, CLOSE_TIMEOUT_MS);
      t.unref?.();
      s.once('close', () => {
        clearTimeout(t);
        resolve();
      });
      s.end();
    });
  }

  return {
    hello,
    supports,
    list,
    start,
    write,
    resize,
    stop,
    attach,
    clearBuffer,
    markRead,
    getPid,
    onOutput,
    onExit,
    onStatus,
    onDisconnect,
    close,
  };
}

module.exports = {
  MAX_LINE_BYTES,
  REQUEST_TIMEOUT_MS,
  createSessionHostClient,
};
