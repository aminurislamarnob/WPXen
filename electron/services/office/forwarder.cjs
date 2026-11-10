'use strict';

// ── WPXen hook forwarder ─────────────────────────────────────
// The script Claude Code's hooks run: `node <userData>/wpxen-hook-forwarder.cjs
// # wpxen`. It is COPIED into the app's userData directory by
// hooksInstaller.cjs at install time and executed by the system `node`, so it
// must be dependency-free — node core only, no requires into the app bundle
// (which moves, updates and may not be running).
//
// It reads the hook JSON from stdin, wraps it as a hook_event domain event with
// pid = ppid (the Claude Code process that invoked the hook), writes one line
// to WPXen's unix domain socket, and exits 0 — ALWAYS, fast, silently. When the
// socket is absent (WPXen isn't running) it exits 0 before even reading stdin.
// It can never block or fail Claude Code. Port of claude-agent-verse
// packages/server/src/forwarder.ts with the HTTP+token transport replaced by
// the socket (spec #178).
//
// The socket lives beside this file: hooksInstaller.cjs writes the forwarder
// into the same userData directory hookSocket.cjs listens in, so the path is
// derived, never baked in. The name must match hookSocket.cjs's
// WPXEN_HOOK_SOCKET_NAME (asserted by test/office-hook-socket.test.js).

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const SOCKET_PATH = path.join(__dirname, 'wpxen-hook.sock');

// Hard ceiling: whatever happens below, Claude Code gets its exit 0 within ~1s.
setTimeout(() => process.exit(0), 1000);

// WPXen not running — nothing to forward.
if (!fs.existsSync(SOCKET_PATH)) process.exit(0);

async function forward() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let hookData;
  try {
    hookData = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const line = JSON.stringify({ type: 'hook_event', pid: process.ppid, hookData }) + '\n';

  const socket = net.connect(SOCKET_PATH);
  socket.on('error', () => process.exit(0));
  socket.on('connect', () => {
    socket.end(line, () => process.exit(0));
  });
}

forward().catch(() => process.exit(0));
