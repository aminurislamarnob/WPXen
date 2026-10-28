'use strict';

// ── Session scanner ──────────────────────────────────────────
// One-time faithful port of claude-agent-verse packages/server/src/scanner.ts
// (replay mode dropped — WPXen does not port the replay harness).
//
// Claude Code writes one JSON file per running process at
//   ~/.claude/sessions/<pid>.json
// with pid, sessionId, cwd, name, status, statusUpdatedAt, startedAt.
// Key/token files sitting beside them (*.key) are credentials and MUST NOT be
// read — the filter below is a guardrail the spec depends on.
//
// The CLAUDE_HOME env override is the test seam: scans run against a temp
// directory in tests. Electron-free: plain node APIs only.

const { readdir, readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { homedir } = require('node:os');
const { getProjectKey } = require('./projectKey.cjs');
const { pidAlive } = require('../procman.cjs');

/** @typedef {import('./types.cjs').DomainEvent} DomainEvent */

/**
 * Snapshot of live sessions from the last scan, keyed by PID — the diff base
 * for the next scan.
 * @typedef {Object} ScanSnapshot
 * @property {Map<number, { sessionId: string, cwd: string, name: string,
 *   startedAt: number, status?: string, statusUpdatedAt?: number }>} sessions
 */

/**
 * Claude Code's folder name for a working directory under ~/.claude/projects:
 * every character other than a letter or digit becomes "-".
 * @param {string} cwd
 * @returns {string}
 */
function projectSlug(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * The Claude home directory. CLAUDE_HOME overrides it (the test seam); an
 * empty string counts as unset, the same as the installer always read it.
 * @returns {string}
 */
function claudeHome() {
  return process.env.CLAUDE_HOME || join(homedir(), '.claude');
}

/** @returns {string} */
function sessionsDir() {
  return join(claudeHome(), 'sessions');
}

/**
 * Scan the session registry and emit domain events for changes since the
 * previous snapshot. Returns the new snapshot.
 * @param {ScanSnapshot} prev
 * @returns {Promise<{ events: DomainEvent[], snapshot: ScanSnapshot }>}
 */
async function scan(prev) {
  const dir = sessionsDir();
  /** @type {DomainEvent[]} */
  const events = [];
  /** @type {ScanSnapshot} */
  const next = { sessions: new Map() };

  let files;
  try {
    files = await readdir(dir);
  } catch {
    // Directory doesn't exist or isn't readable — return empty.
    // Emit ended events for any previously known sessions.
    for (const pid of prev.sessions.keys()) {
      events.push({ type: 'session_ended', pid });
    }
    return { events, snapshot: next };
  }

  // Only read .json files, skip .key files (credentials — guardrail).
  const jsonFiles = files.filter((f) => f.endsWith('.json') && !f.includes('.key'));

  for (const file of jsonFiles) {
    try {
      const raw = await readFile(join(dir, file), 'utf-8');
      const entry = JSON.parse(raw);

      // Skip entries without a pid.
      if (typeof entry.pid !== 'number') continue;

      // Verify the process is still alive — dead pids are never shown as live.
      if (!pidAlive(entry.pid)) continue;

      const name = entry.name ?? `session-${entry.pid}`;
      const startedAt = entry.startedAt ?? Date.now();

      const status = typeof entry.status === 'string' ? entry.status : undefined;
      const statusUpdatedAt =
        typeof entry.statusUpdatedAt === 'number' ? entry.statusUpdatedAt : undefined;
      next.sessions.set(entry.pid, {
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        name,
        startedAt,
        status,
        statusUpdatedAt,
      });

      const prevSession = prev.sessions.get(entry.pid);

      if (!prevSession) {
        // New session appeared.
        const projectKey = await getProjectKey(entry.cwd);
        events.push({
          type: 'session_appeared',
          pid: entry.pid,
          sessionId: entry.sessionId,
          cwd: entry.cwd,
          name,
          projectKey,
          startedAt,
        });
      }

      if (
        status !== undefined &&
        (!prevSession ||
          prevSession.status !== status ||
          prevSession.statusUpdatedAt !== statusUpdatedAt ||
          prevSession.sessionId !== entry.sessionId)
      ) {
        events.push({
          type: 'session_status',
          pid: entry.pid,
          status,
          at: statusUpdatedAt,
          sessionId: entry.sessionId,
        });
      }
    } catch {
      // Skip files that can't be read or parsed (guardrail: skip unknown formats).
      continue;
    }
  }

  // Detect ended sessions — previously known PIDs no longer in the new snapshot.
  for (const pid of prev.sessions.keys()) {
    if (!next.sessions.has(pid)) {
      events.push({ type: 'session_ended', pid });
    }
  }

  return { events, snapshot: next };
}

/** @returns {ScanSnapshot} */
function emptyScanSnapshot() {
  return { sessions: new Map() };
}

module.exports = { scan, emptyScanSnapshot, projectSlug, claudeHome, sessionsDir };
