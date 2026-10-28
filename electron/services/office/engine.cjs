'use strict';

// ── Office engine ────────────────────────────────────────────
// The poll loop behind the Office section, distilled from claude-agent-verse
// packages/server/src/main.ts with the transport cut away: no HTTP, no
// WebSocket, no tokens — snapshots leave through an injected onSnapshot
// callback (ipc.cjs binds it to the 'office-update' channel).
//
// Every second (a setTimeout chain, like startStatusPoller — a slow scan can
// never stack overlapping runs) it diffs the Claude Code session registry,
// dispatches the resulting domain events through the pure reducer, tails each
// live session's transcript under $CLAUDE_HOME/projects/<slug>, and emits a
// tick. Two throttles guard the IPC channel: a snapshot is scheduled only when
// the reducer returned a *different* Office reference, and scheduled snapshots
// coalesce (~100 ms) so a cold-start transcript replay lands as one push.
//
// Lifecycle: lazy single-start — the first Office visit calls start(), which
// is idempotent; the engine then stays warm until app quit calls stop().
// Subagent discovery (#183), Antigravity (#186) and the hook socket (#187)
// land later.
//
// Electron-free (the ratchet test enforces it): effects are injected through
// `deps`, swappable in tests via __setDeps.

const { join } = require('node:path');
const { reduce, emptyOffice } = require('./reducer.cjs');
const scanner = require('./scanner.cjs');
const { FileTailer } = require('./tailer.cjs');

/** @typedef {import('./types.cjs').Office} Office */
/** @typedef {import('./types.cjs').DomainEvent} DomainEvent */

/** Registry + transcript poll cadence (the source product's constant). */
const POLL_INTERVAL_MS = 1000;
/** Burst window: changes within it collapse into one snapshot push. */
const SNAPSHOT_COALESCE_MS = 100;

// Swapped in tests — .cjs modules load through Node's CJS loader, out of
// vi.mock's reach (same seam as browser.cjs / externalTools.cjs).
let overrides = {};

const deps = {
  get scan() {
    return 'scan' in overrides ? overrides.scan : scanner.scan;
  },
  get createTailer() {
    return 'createTailer' in overrides
      ? overrides.createTailer
      : (filePath) => new FileTailer(filePath);
  },
  /** Receives every pushed Office snapshot. Bound by ipc.cjs at start(). */
  get onSnapshot() {
    return 'onSnapshot' in overrides ? overrides.onSnapshot : () => {};
  },
  get now() {
    return 'now' in overrides ? overrides.now : () => Date.now();
  },
  get pollIntervalMs() {
    return 'pollIntervalMs' in overrides ? overrides.pollIntervalMs : POLL_INTERVAL_MS;
  },
  get coalesceMs() {
    return 'coalesceMs' in overrides ? overrides.coalesceMs : SNAPSHOT_COALESCE_MS;
  },
};

function __setDeps(next) {
  overrides = { ...overrides, ...next };
}

// ── State ────────────────────────────────────────────────────

/** @type {Office} */
let office = emptyOffice();
let scanSnapshot = scanner.emptyScanSnapshot();
/** One transcript tailer per live pid. @type {Map<number, { sessionId: string, tailer: { stop: () => void } }>} */
const tailers = new Map();
let started = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let pollTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let snapshotTimer = null;

// ── Transcript tailing ───────────────────────────────────────

/**
 * Where Claude Code writes a session's transcript: beside the registry, under
 * the project's slug folder.
 * @param {string} cwd
 * @param {string} sessionId
 */
function claudeTranscriptPath(cwd, sessionId) {
  return join(
    scanner.claudeHome(),
    'projects',
    scanner.projectSlug(cwd),
    `${sessionId}.jsonl`
  );
}

/**
 * (Re)tail a session's transcript, replacing any previous tailer for the pid.
 * @param {number} pid
 * @param {string} transcriptPath
 * @param {string} sessionId
 */
function tailTranscript(pid, transcriptPath, sessionId) {
  tailers.get(pid)?.tailer.stop();
  const tailer = deps.createTailer(transcriptPath);
  tailers.set(pid, { sessionId, tailer });
  tailer.on('line', (line) => {
    // Lines from a transcript we've since switched away from are stale.
    if (tailers.get(pid)?.tailer !== tailer) return;
    dispatch({ type: 'transcript_line', pid, line });
  });
  tailer.start().catch((err) => {
    console.error(`[office] failed to tail transcript for pid ${pid}:`, err);
  });
}

// ── Dispatch ─────────────────────────────────────────────────

/**
 * Run one domain event through the reducer, perform its side effects (tailer
 * wiring), and schedule a snapshot push when the Office actually changed.
 * @param {DomainEvent} event
 */
function dispatch(event) {
  const before = office;
  office = reduce(office, event);

  if (event.type === 'session_appeared') {
    tailTranscript(
      event.pid,
      claudeTranscriptPath(event.cwd, event.sessionId),
      event.sessionId
    );
  } else if (event.type === 'session_status') {
    // A new conversation in the same process writes to a new transcript file.
    const current = tailers.get(event.pid);
    const session = office.sessions[event.pid];
    if (session && current && current.sessionId !== event.sessionId) {
      tailTranscript(
        event.pid,
        claudeTranscriptPath(session.cwd, event.sessionId),
        event.sessionId
      );
    }
  } else if (event.type === 'session_ended') {
    const current = tailers.get(event.pid);
    if (current) {
      current.tailer.stop();
      tailers.delete(event.pid);
    }
  }

  // The reducer returns the same Office when nothing changed (most ticks); skip those.
  if (office !== before) scheduleSnapshot();
}

/** Coalesces bursts (a transcript replayed at startup) into one snapshot per window. */
function scheduleSnapshot() {
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    deps.onSnapshot(office);
  }, deps.coalesceMs);
}

// ── Poll loop ────────────────────────────────────────────────

async function poll() {
  try {
    const result = await deps.scan(scanSnapshot);
    scanSnapshot = result.snapshot;
    for (const event of result.events) dispatch(event);

    dispatch({ type: 'tick', now: deps.now() });
  } catch (err) {
    console.error('[office] poll error:', err);
  }
}

// ── Lifecycle ────────────────────────────────────────────────

/**
 * Start the engine: one immediate poll, then the setTimeout chain. Lazy and
 * idempotent — the first Office visit starts it, later calls are no-ops, and
 * it runs until stop() at app quit. Returns the current Office either way.
 * @param {{ onSnapshot?: (office: Office) => void }} [effects] Bound on first
 *   start; snapshots flow to it from then on.
 * @returns {Office}
 */
function start(effects = {}) {
  if (started) return office;
  started = true;
  if (effects.onSnapshot) __setDeps({ onSnapshot: effects.onSnapshot });

  const loop = async () => {
    await poll();
    if (!started) return;
    pollTimer = setTimeout(loop, deps.pollIntervalMs);
  };
  loop();
  return office;
}

/** Stop polling and release every tailer's file handle. Called at app quit. */
function stop() {
  started = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (snapshotTimer) {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
  }
  for (const { tailer } of tailers.values()) tailer.stop();
  tailers.clear();
}

/** @returns {Office} */
function getOffice() {
  return office;
}

/** @returns {boolean} */
function isStarted() {
  return started;
}

/** Test-only: stop and wipe all state and dep overrides. */
function __reset() {
  stop();
  office = emptyOffice();
  scanSnapshot = scanner.emptyScanSnapshot();
  overrides = {};
}

module.exports = {
  start,
  stop,
  getOffice,
  isStarted,
  dispatch,
  POLL_INTERVAL_MS,
  SNAPSHOT_COALESCE_MS,
  __setDeps,
  __reset,
};
