'use strict';

// ── Session Host server (#230) ───────────────────────────────────────────────
// A small standalone server that owns ptys on behalf of a client over a private
// owner-only (0600) Unix domain socket, speaking line-delimited JSON.
//
// Additive-only protocol rule:
//   Fields and message types may be added in future protocol versions, never
//   renamed, removed, or given a new meaning, because a newer WPXen app must
//   always be able to talk to a Session Host started by an older version.
//   Every wire message carries `v: PROTOCOL_VERSION`.
//
// Electron-free: loads under plain Node (or Electron with ELECTRON_RUN_AS_NODE=1).

const fs = require('fs');
const net = require('net');
const pty = require('node-pty');
const { createTracker, isTerminalReply } = require('./agentStatus.cjs');
const {
  MAX_HISTORY_BYTES,
  appendHistory,
  readHistory,
  clearHistory,
  deleteHistory,
} = require('./sessionHistory.cjs');

const PROTOCOL_VERSION = 1;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_BUFFER = 1024 * 1024; // ~1 MB in-memory ring buffer per Session
const KILL_GRACE_MS = 3000;
const MAX_IDLE_MS = 24 * 60 * 60 * 1000; // 24-hour disconnected limit (#234)

const KNOWN_CLIENT_TYPES = new Set([
  'hello',
  'list',
  'start',
  'write',
  'resize',
  'stop',
  'attach',
  'clear-buffer',
  'mark-read',
]);

const KNOWN_HOST_EVENT_TYPES = new Set(['output', 'status', 'exit']);

// Validate and parse one JSON line sent by a client to the host.
// Used both by the server and by the protocol contract test.
function parseClientMessage(line) {
  let msg;
  try {
    msg = typeof line === 'string' ? JSON.parse(line) : line;
  } catch {
    return { ok: false, id: null, error: 'Malformed JSON' };
  }
  if (!msg || typeof msg !== 'object') {
    return { ok: false, id: null, error: 'Message must be an object' };
  }
  const id = msg.id ?? null;
  if (typeof msg.v !== 'number' || !Number.isInteger(msg.v) || msg.v < 1) {
    return { ok: false, id, error: 'Missing or invalid protocol version (v)' };
  }
  if (typeof msg.type !== 'string' || !KNOWN_CLIENT_TYPES.has(msg.type)) {
    return { ok: false, id, error: `Unknown request type: ${msg.type}` };
  }
  return { ok: true, id, message: msg };
}

// Validate and parse one JSON line sent by the host to a client (reply or event).
function parseHostMessage(line) {
  let msg;
  try {
    msg = typeof line === 'string' ? JSON.parse(line) : line;
  } catch {
    return { ok: false, error: 'Malformed JSON' };
  }
  if (!msg || typeof msg !== 'object') {
    return { ok: false, error: 'Message must be an object' };
  }
  if (typeof msg.v !== 'number' || !Number.isInteger(msg.v) || msg.v < 1) {
    return { ok: false, error: 'Missing or invalid protocol version (v)' };
  }
  if (typeof msg.type === 'string') {
    if (!KNOWN_HOST_EVENT_TYPES.has(msg.type)) {
      return { ok: false, error: `Unknown event type: ${msg.type}` };
    }
    return { ok: true, kind: 'event', message: msg };
  }
  if (typeof msg.ok !== 'boolean') {
    return { ok: false, error: 'Reply missing boolean ok field' };
  }
  return { ok: true, kind: 'reply', message: msg };
}

function createSessionHost({
  socketPath,
  appVersion = '0.0.0',
  historyDir = null,
  maxHistoryBytes = MAX_HISTORY_BYTES,
  spawnPty = (file, args, opts) => pty.spawn(file, args, opts),
  now = () => Date.now(),
  maxBuffer = MAX_BUFFER,
  killGraceMs = KILL_GRACE_MS,
  idleTimeoutMs = MAX_IDLE_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  onExit = null,
} = {}) {
  if (!socketPath) throw new Error('socketPath is required');

  const sessions = new Map(); // sessionId -> { sessionId, term, pid, cwd, startedAt, buffer, exited, exitCode }
  const clients = new Set(); // active net.Socket connections
  let server = null;
  let closed = false;
  let hadSession = false;
  let idleTimer = null;
  let lastDisconnectedAt = null;

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeoutFn(idleTimer);
      idleTimer = null;
    }
    lastDisconnectedAt = null;
  }

  function scheduleIdleTimer() {
    if (closed || clients.size > 0 || idleTimeoutMs <= 0) return;
    if (idleTimer) clearTimeoutFn(idleTimer);
    lastDisconnectedAt = now();
    idleTimer = setTimeoutFn(() => {
      idleTimer = null;
      if (closed || clients.size > 0) return;
      if (lastDisconnectedAt != null && now() - lastDisconnectedAt < idleTimeoutMs) {
        return;
      }
      close().then(() => {
        if (typeof onExit === 'function') onExit();
      });
    }, idleTimeoutMs);
    idleTimer?.unref?.();
  }

  function sendLine(conn, payload) {
    if (conn.destroyed) return;
    try {
      conn.write(JSON.stringify({ v: PROTOCOL_VERSION, ...payload }) + '\n');
    } catch {}
  }

  function broadcastEvent(payload) {
    const line = JSON.stringify({ v: PROTOCOL_VERSION, ...payload }) + '\n';
    for (const conn of clients) {
      if (!conn.destroyed) {
        try {
          conn.write(line);
        } catch {}
      }
    }
  }

  function hasLiveSessions() {
    for (const s of sessions.values()) {
      if (!s.exited) return true;
    }
    return false;
  }

  // Exit when the last Session has ended and no client is connected.
  function maybeAutoExit() {
    if (closed || !hadSession) return;
    if (clients.size > 0) return;
    if (hasLiveSessions()) return;
    close().then(() => {
      if (typeof onExit === 'function') onExit();
    });
  }

  function sessionSummary(s) {
    const snap = s.tracker.snapshot();
    return {
      sessionId: s.sessionId,
      pid: s.pid,
      cwd: s.cwd,
      startedAt: s.startedAt,
      exited: s.exited,
      exitCode: s.exitCode,
      state: snap.state,
      title: snap.title,
      changedAt: snap.changedAt,
      unread: snap.unread,
    };
  }

  function broadcastStatus(s) {
    const snap = s.tracker.snapshot();
    broadcastEvent({
      type: 'status',
      sessionId: s.sessionId,
      state: snap.state,
      title: snap.title,
      changedAt: snap.changedAt,
      unread: snap.unread,
    });
  }

  function stopSession(sessionId) {
    const s = sessions.get(sessionId);
    if (historyDir) deleteHistory(historyDir, sessionId);
    if (!s) return;
    sessions.delete(sessionId);
    if (!s.exited && s.term) {
      try {
        s.term.kill('SIGTERM');
      } catch {}
      const term = s.term;
      const t = setTimeout(() => {
        if (!s.exited) {
          try {
            term.kill('SIGKILL');
          } catch {}
        }
      }, killGraceMs);
      t.unref?.();
    }
    maybeAutoExit();
  }

  function handleRequest(conn, rawLine) {
    const parsed = parseClientMessage(rawLine);
    if (!parsed.ok) {
      sendLine(conn, { id: parsed.id, ok: false, error: parsed.error });
      return;
    }
    const msg = parsed.message;
    const id = msg.id ?? null;

    switch (msg.type) {
      case 'hello': {
        sendLine(conn, {
          id,
          ok: true,
          appVersion,
          protocolVersion: PROTOCOL_VERSION,
        });
        return;
      }

      case 'list': {
        sendLine(conn, {
          id,
          ok: true,
          sessions: [...sessions.values()].map(sessionSummary),
        });
        return;
      }

      case 'start': {
        const sessionId = String(msg.sessionId || '').trim();
        const file = String(msg.file || '').trim();
        if (!sessionId || !file) {
          sendLine(conn, { id, ok: false, error: 'sessionId and file are required' });
          return;
        }
        if (sessions.has(sessionId) && !sessions.get(sessionId).exited) {
          sendLine(conn, {
            id,
            ok: true,
            sessionId,
            pid: sessions.get(sessionId).pid,
          });
          return;
        }
        let term;
        try {
          term = spawnPty(file, Array.isArray(msg.args) ? msg.args : [], {
            name: msg.name || 'xterm-256color',
            cols: Number(msg.cols) > 0 ? Number(msg.cols) : 80,
            rows: Number(msg.rows) > 0 ? Number(msg.rows) : 24,
            cwd: msg.cwd || process.cwd(),
            env: msg.env && typeof msg.env === 'object' ? msg.env : process.env,
          });
        } catch (err) {
          sendLine(conn, { id, ok: false, error: err.message || 'spawn failed' });
          return;
        }

        hadSession = true;
        const tracker = createTracker({
          now,
          agent: msg.agent !== false,
        });
        const entry = {
          sessionId,
          term,
          pid: term?.pid ?? null,
          cwd: msg.cwd || null,
          startedAt: now(),
          buffer: '',
          exited: false,
          exitCode: null,
          tracker,
        };
        sessions.set(sessionId, entry);

        term.onData((data) => {
          if (entry.exited) return;
          if (historyDir) {
            appendHistory(historyDir, sessionId, data, maxHistoryBytes);
          } else {
            entry.buffer += data;
            if (entry.buffer.length > maxBuffer) {
              entry.buffer = entry.buffer.slice(entry.buffer.length - maxBuffer);
            }
          }
          broadcastEvent({ type: 'output', sessionId, data });
          if (entry.tracker.output(data)) {
            entry.tracker.drainEvents();
            broadcastStatus(entry);
          } else {
            entry.tracker.drainEvents();
          }
        });

        term.onExit(({ exitCode } = {}) => {
          if (entry.exited) return;
          entry.exited = true;
          entry.exitCode = exitCode ?? 0;
          if (entry.tracker.exit(entry.exitCode)) {
            entry.tracker.drainEvents();
            broadcastStatus(entry);
          } else {
            entry.tracker.drainEvents();
          }
          broadcastEvent({ type: 'exit', sessionId, exitCode: entry.exitCode });
          maybeAutoExit();
        });

        sendLine(conn, { id, ok: true, sessionId, pid: entry.pid });
        return;
      }

      case 'write': {
        const s = sessions.get(msg.sessionId);
        if (s && !s.exited && typeof msg.data === 'string') {
          try {
            s.term.write(msg.data);
          } catch {}
          if (!isTerminalReply(msg.data) && s.tracker.typed()) {
            broadcastStatus(s);
          }
        }
        sendLine(conn, { id, ok: true });
        return;
      }

      case 'resize': {
        const s = sessions.get(msg.sessionId);
        const cols = Number(msg.cols);
        const rows = Number(msg.rows);
        if (s && !s.exited && cols > 0 && rows > 0) {
          try {
            s.term.resize(cols, rows);
          } catch {}
        }
        sendLine(conn, { id, ok: true });
        return;
      }

      case 'attach': {
        const s = sessions.get(msg.sessionId);
        if (!s) {
          sendLine(conn, { id, ok: false, error: 'Session not found' });
          return;
        }
        const snap = s.tracker.snapshot();
        const data = historyDir ? readHistory(historyDir, s.sessionId) : s.buffer;
        sendLine(conn, {
          id,
          ok: true,
          sessionId: s.sessionId,
          data,
          exited: s.exited,
          exitCode: s.exitCode,
          state: snap.state,
          title: snap.title,
          changedAt: snap.changedAt,
          unread: snap.unread,
        });
        return;
      }

      case 'mark-read': {
        const s = sessions.get(msg.sessionId);
        if (!s) {
          sendLine(conn, { id, ok: false, error: 'Session not found' });
          return;
        }
        const read = msg.read !== false;
        const changed = read ? s.tracker.markRead() : s.tracker.markUnread();
        if (changed) broadcastStatus(s);
        const snap = s.tracker.snapshot();
        sendLine(conn, {
          id,
          ok: true,
          sessionId: s.sessionId,
          ...snap,
        });
        return;
      }

      case 'clear-buffer': {
        const s = sessions.get(msg.sessionId);
        if (s) s.buffer = '';
        if (historyDir) clearHistory(historyDir, msg.sessionId);
        sendLine(conn, { id, ok: true });
        return;
      }

      case 'stop': {
        stopSession(msg.sessionId);
        sendLine(conn, { id, ok: true });
        return;
      }
    }
  }

  function start() {
    if (server) return Promise.resolve(socketPath);
    try {
      fs.unlinkSync(socketPath);
    } catch {}

    server = net.createServer((conn) => {
      clients.add(conn);
      clearIdleTimer();
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.trim()) handleRequest(conn, line);
        }
        if (buf.length > MAX_LINE_BYTES) buf = '';
      });
      const cleanup = () => {
        if (clients.delete(conn)) {
          maybeAutoExit();
          if (!closed && clients.size === 0) scheduleIdleTimer();
        }
      };
      conn.on('close', cleanup);
      conn.on('error', cleanup);
    });

    return new Promise((resolve, reject) => {
      server.once('error', reject);
      const prevUmask = process.umask(0o177);
      try {
        server.listen(socketPath, () => {
          try {
            fs.chmodSync(socketPath, 0o600);
          } catch {}
          resolve(socketPath);
        });
      } finally {
        process.umask(prevUmask);
      }
    });
  }

  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    clearIdleTimer();
    for (const s of sessions.values()) {
      if (!s.exited && s.term) {
        try {
          s.term.kill('SIGTERM');
        } catch {}
      }
    }
    sessions.clear();
    for (const conn of clients) {
      try {
        conn.destroy();
      } catch {}
    }
    clients.clear();
    return new Promise((resolve) => {
      const done = () => {
        try {
          fs.unlinkSync(socketPath);
        } catch {}
        resolve();
      };
      if (!server) return done();
      const srv = server;
      server = null;
      srv.close(done);
    });
  }

  return {
    start,
    close,
    socketPath,
  };
}

function parseCliArgs(argv = process.argv.slice(2)) {
  let socketPath = process.env.WPXEN_SESSION_HOST_SOCKET || null;
  let appVersion = process.env.WPXEN_SESSION_HOST_VERSION || '0.0.0';
  let historyDir = process.env.WPXEN_SESSION_HISTORY_DIR || null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--socket' && argv[i + 1]) {
      socketPath = argv[++i];
    } else if (argv[i] === '--version' && argv[i + 1]) {
      appVersion = argv[++i];
    } else if (argv[i] === '--history-dir' && argv[i + 1]) {
      historyDir = argv[++i];
    }
  }
  return { socketPath, appVersion, historyDir };
}

if (require.main === module) {
  const { socketPath, appVersion, historyDir } = parseCliArgs();
  if (!socketPath) {
    process.stderr.write('sessionHost: --socket is required\n');
    process.exit(1);
  }
  const host = createSessionHost({
    socketPath,
    appVersion,
    historyDir,
    onExit: () => process.exit(0),
  });
  host.start().catch((err) => {
    process.stderr.write(`sessionHost: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  PROTOCOL_VERSION,
  MAX_IDLE_MS,
  KNOWN_CLIENT_TYPES,
  KNOWN_HOST_EVENT_TYPES,
  parseClientMessage,
  parseHostMessage,
  parseCliArgs,
  createSessionHost,
};
