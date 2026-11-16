'use strict';

// ── Terminal provider interface (#229) ───────────────────────────────────────
// The Session engine (services/agents.cjs) never calls node-pty directly. Every
// terminal operation goes through a provider matching this contract so status
// tracking, the chat view, notifications, the ring buffer and the Projects list
// are unaware of whether a Session's pty runs in-process (the in-app provider
// below) or in a detached Session Host process (#230/#231).
//
// Methods:
//   start({ sessionId, file, args, cwd, cols, rows, env })
//     Spawns a terminal for `sessionId` and returns `{ pid }` (or a Promise of
//     it). Throws if the spawn fails.
//   write(sessionId, data)
//     Writes UTF-8 `data` to `sessionId`'s terminal. No-op when `sessionId` is
//     unknown or has already exited.
//   resize(sessionId, cols, rows)
//     Resizes `sessionId`'s terminal to `cols` × `rows` (both > 0). No-op when
//     unknown or exited.
//   stop(sessionId, { keepHistory })
//     Terminates `sessionId` gracefully (SIGTERM, escalating to SIGKILL after
//     KILL_GRACE_MS if still alive) and releases its handle, exited or not.
//     `keepHistory` keeps on-disk history (host only; the in-app provider
//     has none).
//   stopAll()
//     stop() for every Session (in-app provider).
//   attach(sessionId)
//     Returns `{ data, exited, exitCode }` (or a Promise of it) with the
//     buffered output in emission order and whether the terminal has exited, or
//     `null` if `sessionId` is unknown.
//   clearBuffer(sessionId)
//     Empties the replay buffer (and the host's history file).
//   getPid(sessionId)
//     Returns the root shell pid for `sessionId`, or `null`.
//
// Optional, host client only (agents.cjs checks before calling):
//   markRead(sessionId, read), onStatus(cb), onDisconnect(cb), and the
//   proxy's `isHostProvider` / `version`.
//
// Events (each returns an unsubscribe `() => void`):
//   onOutput(cb) — `cb({ sessionId, data })`
//   onExit(cb)   — `cb({ sessionId, exitCode })`
//
// Provider guarantees:
//   1. Output chunks for a `sessionId` are emitted on `onOutput` in the exact
//      order the terminal produced them, and never after `onExit` for that
//      `sessionId`.
//   2. `onExit` fires at most once per `sessionId` (exactly once when the
//      process exits). Duplicate exit signals from the underlying layer are
//      suppressed.

const pty = require('node-pty');

const MAX_BUFFER = 1024 * 1024; // ~1 MB ring buffer per Session
const KILL_GRACE_MS = 3000;

function defaultSpawnPty(file, args, opts) {
  return pty.spawn(file, args, opts);
}

function createInAppTerminalProvider({
  spawnPty = defaultSpawnPty,
  maxBuffer = MAX_BUFFER,
  killGraceMs = KILL_GRACE_MS,
} = {}) {
  const entries = new Map(); // sessionId -> { term, pid, buffer, exited, exitCode }
  const outputListeners = new Set();
  const exitListeners = new Set();

  function onOutput(cb) {
    outputListeners.add(cb);
    return () => outputListeners.delete(cb);
  }

  function onExit(cb) {
    exitListeners.add(cb);
    return () => exitListeners.delete(cb);
  }

  function start({
    sessionId,
    file,
    args = [],
    cwd,
    cols = 80,
    rows = 24,
    env = {},
    name = 'xterm-256color',
  }) {
    const term = spawnPty(file, args, { name, cols, rows, cwd, env });
    const entry = {
      sessionId,
      term,
      pid: term?.pid ?? null,
      buffer: '',
      exited: false,
      exitCode: null,
    };
    entries.set(sessionId, entry);

    term.onData((data) => {
      if (entry.exited) return;
      entry.buffer += data;
      if (entry.buffer.length > maxBuffer) {
        entry.buffer = entry.buffer.slice(entry.buffer.length - maxBuffer);
      }
      for (const cb of outputListeners) {
        try {
          cb({ sessionId, data });
        } catch {}
      }
    });

    term.onExit(({ exitCode } = {}) => {
      if (entry.exited) return;
      entry.exited = true;
      entry.exitCode = exitCode ?? 0;
      for (const cb of exitListeners) {
        try {
          cb({ sessionId, exitCode: entry.exitCode });
        } catch {}
      }
    });

    return { pid: entry.pid };
  }

  function write(sessionId, data) {
    const entry = entries.get(sessionId);
    if (!entry || entry.exited) return;
    try {
      entry.term.write(data);
    } catch {}
  }

  function resize(sessionId, cols, rows) {
    const entry = entries.get(sessionId);
    if (!entry || entry.exited || !(cols > 0 && rows > 0)) return;
    try {
      entry.term.resize(cols, rows);
    } catch {}
  }

  function attach(sessionId) {
    const entry = entries.get(sessionId);
    if (!entry) return null;
    return {
      data: entry.buffer,
      exited: entry.exited,
      exitCode: entry.exitCode,
    };
  }

  function clearBuffer(sessionId) {
    const entry = entries.get(sessionId);
    if (entry) entry.buffer = '';
  }

  function getPid(sessionId) {
    return entries.get(sessionId)?.term?.pid ?? entries.get(sessionId)?.pid ?? null;
  }

  function stop(sessionId) {
    const entry = entries.get(sessionId);
    if (!entry) return;
    entries.delete(sessionId);
    if (!entry.exited && entry.term) {
      try {
        entry.term.kill('SIGTERM');
      } catch {}
      const term = entry.term;
      setTimeout(() => {
        if (!entry.exited) {
          try {
            term.kill('SIGKILL');
          } catch {}
        }
      }, killGraceMs);
    }
  }

  function stopAll() {
    for (const id of [...entries.keys()]) stop(id);
  }

  return {
    start,
    write,
    resize,
    stop,
    stopAll,
    attach,
    clearBuffer,
    getPid,
    onOutput,
    onExit,
  };
}

module.exports = {
  MAX_BUFFER,
  KILL_GRACE_MS,
  defaultSpawnPty,
  createInAppTerminalProvider,
};
