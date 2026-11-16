'use strict';

// ── Session Host client (#230) ───────────────────────────────────────────────
// Connects to a Session Host over its Unix domain socket and exposes the same
// terminal-provider shape (start, write, resize, stop, attach, clearBuffer,
// getPid, onOutput, onExit) plus host-level `hello`, `list` and `close`.
//
// Electron-free: loads under plain Node.

const net = require('net');
const { PROTOCOL_VERSION, parseHostMessage } = require('./sessionHost.cjs');

const MAX_LINE_BYTES = 8 * 1024 * 1024;

function createSessionHostClient({ socketPath } = {}) {
  if (!socketPath) throw new Error('socketPath is required');

  let conn = null;
  let connecting = null;
  let nextId = 1;
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

  function handleLine(line) {
    const parsed = parseHostMessage(line);
    if (!parsed.ok) return;
    const msg = parsed.message;

    if (parsed.kind === 'event') {
      if (msg.type === 'output') {
        if (exitedSessions.has(msg.sessionId)) return;
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
        if (exitedSessions.has(msg.sessionId)) return;
        exitedSessions.add(msg.sessionId);
        for (const cb of exitListeners) {
          try {
            cb({ sessionId: msg.sessionId, exitCode: msg.exitCode ?? 0 });
          } catch {}
        }
      }
      return;
    }

    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg);
    else entry.reject(new Error(msg.error || 'Session Host request failed'));
  }

  function failAllPending(err) {
    for (const { reject } of pending.values()) {
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
      let buf = '';
      let settled = false;

      socket.once('connect', () => {
        settled = true;
        conn = socket;
        connecting = null;
        resolve(socket);
      });

      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.trim()) handleLine(line);
        }
        if (buf.length > MAX_LINE_BYTES) buf = '';
      });

      const onGone = (err) => {
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

  function sendOnSocket(socket, type, payload) {
    const id = nextId++;
    const line = JSON.stringify({ v: PROTOCOL_VERSION, id, type, ...payload }) + '\n';
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.write(line, (err) => {
        if (err) {
          pending.delete(id);
          reject(err);
        }
      });
    });
  }

  function request(type, payload = {}) {
    if (conn && !conn.destroyed) {
      return sendOnSocket(conn, type, payload);
    }
    return ensureConnected().then((socket) => sendOnSocket(socket, type, payload));
  }

  async function hello() {
    return request('hello');
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
    await request('mark-read', { sessionId, read: !!read });
  }

  async function clearBuffer(sessionId) {
    await request('clear-buffer', { sessionId });
  }

  async function stop(sessionId) {
    pids.delete(sessionId);
    await request('stop', { sessionId });
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
      s.once('close', () => resolve());
      s.end();
    });
  }

  return {
    hello,
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
  createSessionHostClient,
};
