'use strict';

// ── Hook socket ──────────────────────────────────────────────
// The receiving end of the Claude Code hook (spec #178): while the Office
// engine runs, the main process listens on an owner-only (0600) unix domain
// socket in the app's userData directory. The forwarder (forwarder.cjs, copied
// into the same directory by hooksInstaller.cjs) writes one JSON line per hook
// invocation — { type: 'hook_event', pid, hookData } — which is validated
// defensively, normalized, and fed to the engine's dispatch, where the reducer
// maps PermissionRequest/Notification → waiting_on_user, PreToolUse → working,
// and Post* clears the hook-waiting flag. This replaces the source project's
// HTTP + bearer-token transport: the socket's 0600 file permission IS the
// authentication.
//
// Electron-free (the ratchet test): the directory and dispatch are injected —
// by the engine, which gets them from ipc.cjs — and tests swap them through
// start()'s arguments and __setDeps.

const fs = require('fs');
const net = require('net');
const path = require('path');

// Naming law (CLAUDE.md "Legacy names"): the socket file lands in userData
// under the app's current name. Duplicated as a literal in forwarder.cjs,
// which must stay dependency-free — the sync is asserted in
// test/office-hook-socket.test.js.
const WPXEN_HOOK_SOCKET_NAME = 'wpxen-hook.sock';

let overrides = {};

const deps = {
  get dir() {
    return 'dir' in overrides ? overrides.dir : null;
  },
  get dispatch() {
    return 'dispatch' in overrides ? overrides.dispatch : null;
  },
};

function __setDeps(next) {
  overrides = { ...overrides, ...next };
}

/** @type {import('net').Server | null} */
let server = null;
/** @type {string | null} */
let currentPath = null;

// One wire line → one validated, normalized domain event, or null. Claude
// Code's real hook payload names its fields hook_event_name / session_id; the
// reducer reads hookData.type / hookData.sessionId. Normalizing here rather
// than in the forwarder means a future mapping fix needs no hook reinstall.
function toHookEvent(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || parsed.type !== 'hook_event') return null;
  if (typeof parsed.pid !== 'number' || !Number.isFinite(parsed.pid)) return null;
  const raw = parsed.hookData;
  if (!raw || typeof raw !== 'object') return null;

  const type = typeof raw.type === 'string' ? raw.type : raw.hook_event_name;
  if (typeof type !== 'string' || !type) return null;
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : raw.session_id;

  const hookData = { ...raw, type };
  if (typeof sessionId === 'string') hookData.sessionId = sessionId;
  return { type: 'hook_event', pid: parsed.pid, hookData };
}

/**
 * Start listening. Idempotent while running. Returns the socket path, or null
 * when no directory/dispatch is available (the Office then falls back to
 * inferred waiting — no hook, no regression).
 *
 * @param {{ dir?: string, dispatch?: (event: object) => void }} [opts]
 */
function start(opts = {}) {
  const dir = deps.dir || opts.dir;
  const dispatch = deps.dispatch || opts.dispatch;
  if (!dir || typeof dispatch !== 'function') return null;
  if (server) return currentPath;

  const sockPath = path.join(dir, WPXEN_HOOK_SOCKET_NAME);

  // A stale file from a crashed run would make listen() fail with EADDRINUSE.
  try {
    fs.unlinkSync(sockPath);
  } catch {
    // Absent is the normal case.
  }

  server = net.createServer((conn) => {
    let buf = '';
    const handle = (line) => {
      const event = toHookEvent(line);
      if (!event) return;
      try {
        dispatch(event);
      } catch (err) {
        console.error('[office] hook event dispatch failed:', err);
      }
    };
    conn.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        handle(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
      // A line with no newline yet keeps buffering; cap it so a misbehaving
      // client can't grow the buffer without bound.
      if (buf.length > 1024 * 1024) buf = '';
    });
    conn.on('end', () => {
      if (buf.trim()) handle(buf);
      buf = '';
    });
    conn.on('error', () => {
      // A forwarder that died mid-write is its own problem, not ours.
    });
  });

  server.on('error', (err) => {
    console.error('[office] hook socket error:', err);
  });

  // Owner-only from birth: the socket is the auth boundary (replaces the
  // source's bearer token), so it must never be group/world-accessible, even
  // briefly. For a unix-path server the bind — and so the file creation — is
  // synchronous inside listen(), so the umask squeeze covers it and the
  // finally restores it before anything else can create a file under it. The
  // chmod in the callback is belt-and-suspenders.
  const prevUmask = process.umask(0o177);
  try {
    server.listen(sockPath, () => {
      try {
        fs.chmodSync(sockPath, 0o600);
      } catch (err) {
        console.error('[office] failed to chmod hook socket:', err);
      }
    });
  } finally {
    process.umask(prevUmask);
  }

  currentPath = sockPath;
  return sockPath;
}

/** Close the server and unlink the socket file. Safe to call when stopped. */
function stop() {
  if (server) {
    try {
      server.close();
    } catch {
      // Already closing/closed.
    }
    server = null;
  }
  if (currentPath) {
    try {
      fs.unlinkSync(currentPath);
    } catch {
      // Already gone.
    }
    currentPath = null;
  }
}

/** The path the socket is (or would be) at inside `dir`. */
function socketPath(dir) {
  return path.join(dir, WPXEN_HOOK_SOCKET_NAME);
}

module.exports = { start, stop, socketPath, WPXEN_HOOK_SOCKET_NAME, __setDeps };
