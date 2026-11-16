'use strict';

// ── Which conversation a Session's Claude is running ─────────────────────────
// A new Claude Session is launched without `--session-id`, so it opens fresh
// exactly as typing `claude` would. Its conversation id is learned afterwards
// from Claude Code's own registry: one `~/.claude/sessions/<pid>.json` per
// running process, carrying that process's current `sessionId` (it changes on
// /clear, which the pin then follows).
//
// Credentials guardrail: only `<pid>.json` for a pid in the Session's own
// process tree is ever opened. The `*.key` files beside them are credentials;
// nothing here lists the directory, so none can be read by accident.
//
// Electron-free; `CLAUDE_HOME` overrides the directory (the test seam).

const fs = require('fs');
const os = require('os');
const path = require('path');

function sessionsDir() {
  return path.join(
    process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude'),
    'sessions'
  );
}

// `ps -A -o pid=,ppid=` → [[pid, ppid], …]. Pure.
function parsePsTable(stdout) {
  const rows = [];
  for (const line of String(stdout || '').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) rows.push([Number(m[1]), Number(m[2])]);
  }
  return rows;
}

// Every pid below `rootPid`, nearest first. Pure.
function descendantPids(rootPid, table) {
  const children = new Map();
  for (const [pid, ppid] of table) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const out = [];
  const queue = [rootPid];
  const seen = new Set(queue);
  while (queue.length) {
    for (const pid of children.get(queue.shift()) || []) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      out.push(pid);
      queue.push(pid);
    }
  }
  return out;
}

// The sessionId Claude registered for `pid`, or null.
function readSessionId(pid, dir = sessionsDir()) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const entry = JSON.parse(fs.readFileSync(path.join(dir, `${pid}.json`), 'utf8'));
    if (entry && Number(entry.pid) === pid && typeof entry.sessionId === 'string') {
      return entry.sessionId || null;
    }
  } catch {
    // absent (not a Claude process, or it exited) or mid-write
  }
  return null;
}

function listProcesses() {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid='], { timeout: 2000 }, (err, stdout) =>
      resolve(err ? [] : parsePsTable(stdout))
    );
  });
}

module.exports = {
  parsePsTable,
  descendantPids,
  readSessionId,
  listProcesses,
  sessionsDir,
};
