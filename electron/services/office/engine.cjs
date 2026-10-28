'use strict';

// ── Office engine ────────────────────────────────────────────
// The poll loop behind the Office section, distilled from claude-agent-verse
// packages/server/src/main.ts with the transport cut away: no HTTP, no
// WebSocket, no tokens — snapshots leave through an injected onSnapshot
// callback (ipc.cjs binds it to the 'office-update' channel).
//
// Every second (a setTimeout chain, like startStatusPoller — a slow scan can
// never stack overlapping runs) it diffs the Claude Code session registry and
// the Antigravity brain folders (antigravity.cjs, #186), dispatches the
// resulting domain events through the pure reducer, tails each live session's
// transcript — Claude's under $CLAUDE_HOME/projects/<slug>, Antigravity's at
// the conversation's own brain path — and emits a tick. Two throttles guard
// the IPC channel: a snapshot is scheduled only when the reducer returned a
// *different* Office reference, and scheduled snapshots coalesce (~100 ms) so
// a cold-start transcript replay lands as one push.
//
// Lifecycle: lazy single-start — the first Office visit calls start(), which
// is idempotent; the engine then stays warm until app quit calls stop(). While
// it runs, the hook socket (hookSocket.cjs) listens in userData and feeds
// exact hook_event state into the same dispatch; without it the office falls
// back to inferred waiting — Antigravity has no hook, so its waiting state is
// always the running-tool-threshold inference. Each poll also discovers a
// Claude session's subagents (see discoverSubagents) and tails them as interns.
//
// Electron-free (the ratchet test enforces it): effects are injected through
// `deps`, swappable in tests via __setDeps.

const { join } = require('node:path');
const { readdir, readFile, stat } = require('node:fs/promises');
const { reduce, emptyOffice } = require('./reducer.cjs');
const scanner = require('./scanner.cjs');
const antigravity = require('./antigravity.cjs');
const { getProjectKey } = require('./projectKey.cjs');
const { FileTailer } = require('./tailer.cjs');
const hookSocket = require('./hookSocket.cjs');

/** @typedef {import('./types.cjs').Office} Office */
/** @typedef {import('./types.cjs').DomainEvent} DomainEvent */

/** Registry + transcript poll cadence (the source product's constant). */
const POLL_INTERVAL_MS = 1000;
/** Burst window: changes within it collapse into one snapshot push. */
const SNAPSHOT_COALESCE_MS = 100;
/** Subagent transcripts untouched for this long belong to finished work and are skipped. */
const SUBAGENT_STALE_MS = 10 * 60_000;

// Swapped in tests — .cjs modules load through Node's CJS loader, out of
// vi.mock's reach (same seam as browser.cjs / externalTools.cjs).
let overrides = {};

const deps = {
  get scan() {
    return 'scan' in overrides ? overrides.scan : scanner.scan;
  },
  get scanAg() {
    return 'scanAg' in overrides ? overrides.scanAg : antigravity.scanAntigravity;
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
let agSnapshot = antigravity.emptyAgScanSnapshot();
/** One transcript tailer per live pid. @type {Map<number, { sessionId: string, tailer: { stop: () => void } }>} */
const tailers = new Map();
/** One tailer per live subagent, keyed "pid-subagentId". @type {Map<string, { stop: () => void }>} */
const subagentTailers = new Map();
/** Keys of subagents that ended (or were stale on discovery) — never re-tailed. @type {Set<string>} */
const finishedSubagents = new Set();
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
 * @param {(line: *) => void} [onLine] Observes each line after dispatch
 *   (Antigravity workspace inference).
 */
function tailTranscript(pid, transcriptPath, sessionId, onLine) {
  tailers.get(pid)?.tailer.stop();
  const tailer = deps.createTailer(transcriptPath);
  tailers.set(pid, { sessionId, tailer });
  tailer.on('line', (line) => {
    // Lines from a transcript we've since switched away from are stale.
    if (tailers.get(pid)?.tailer !== tailer) return;
    dispatch({ type: 'transcript_line', pid, line });
    onLine?.(line);
  });
  tailer.start().catch((err) => {
    console.error(`[office] failed to tail transcript for pid ${pid}:`, err);
  });
}

/**
 * Release a session's subagent tailers and forget which of its subagents
 * finished — a new conversation (or a new process at the same pid) starts
 * subagent discovery from scratch.
 * @param {number} pid
 */
function stopSubagents(pid) {
  for (const [key, subTailer] of subagentTailers.entries()) {
    if (key.startsWith(`${pid}-`)) {
      subTailer.stop();
      subagentTailers.delete(key);
    }
  }
  for (const key of finishedSubagents) {
    if (key.startsWith(`${pid}-`)) finishedSubagents.delete(key);
  }
}

/**
 * Tail an Antigravity conversation and move it to its project pod once a tool
 * call names its workspace. The transcript carries no cwd, so the first
 * absolute tool-call path (brain-internal paths excluded) is resolved on disk
 * to a folder, then to a project key — the session_workspace dispatch below.
 * @param {number} pid
 * @param {string} conversationId
 */
function tailAntigravity(pid, conversationId) {
  const conversation = agSnapshot.conversations.get(conversationId);
  if (!conversation) return;
  let resolving = false;
  tailTranscript(pid, conversation.transcriptPath, conversationId, (line) => {
    if (resolving) return;
    const path = antigravity.toolPathFromStep(line);
    if (!path) return;
    resolving = true;
    antigravity
      .workspaceDir(path)
      .then(async (cwd) => ({ cwd, projectKey: await getProjectKey(cwd) }))
      .then(({ cwd, projectKey }) => {
        if (office.sessions[pid]?.sessionId === conversationId)
          dispatch({ type: 'session_workspace', pid, cwd, projectKey });
      });
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
    if (event.agent === 'antigravity') {
      tailAntigravity(event.pid, event.sessionId);
    } else {
      tailTranscript(
        event.pid,
        claudeTranscriptPath(event.cwd, event.sessionId),
        event.sessionId
      );
    }
  } else if (event.type === 'session_status') {
    // A new conversation in the same process writes to a new transcript file.
    const current = tailers.get(event.pid);
    const session = office.sessions[event.pid];
    if (session && current && current.sessionId !== event.sessionId) {
      stopSubagents(event.pid);
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
    stopSubagents(event.pid);
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

// ── Subagent discovery ───────────────────────────────────────

/**
 * Per-poll scan for a session's subagents. Their transcripts live beside the
 * session's own, in projects/<slug>/<sessionId>/subagents/, one
 * agent-<id>.meta.json + agent-<id>.jsonl pair each. A fresh pair makes the
 * subagent appear and its transcript gets tailed; an assistant line with no
 * tool_use ends it; a transcript idle past SUBAGENT_STALE_MS is finished work
 * and never appears at all.
 * @param {{ pid: number, cwd: string, sessionId: string }} session
 */
async function discoverSubagents(session) {
  const subagentsDir = join(
    scanner.claudeHome(),
    'projects',
    scanner.projectSlug(session.cwd),
    session.sessionId,
    'subagents'
  );
  try {
    const files = await readdir(subagentsDir);
    const metaFiles = files.filter((f) => f.endsWith('.meta.json'));
    for (const metaFile of metaFiles) {
      const subagentId = metaFile.replace('agent-', '').replace('.meta.json', '');
      const key = `${session.pid}-${subagentId}`;
      if (subagentTailers.has(key) || finishedSubagents.has(key)) continue;

      const jsonlPath = join(subagentsDir, `agent-${subagentId}.jsonl`);
      const mtime = await stat(jsonlPath).then(
        (s) => s.mtimeMs,
        () => 0
      );
      if (deps.now() - mtime > SUBAGENT_STALE_MS) {
        finishedSubagents.add(key);
        continue;
      }
      const metaContent = await readFile(join(subagentsDir, metaFile), 'utf-8');
      const meta = JSON.parse(metaContent);

      dispatch({
        type: 'subagent_appeared',
        pid: session.pid,
        subagentId,
        agentType: meta.agentType || 'Agent',
        description: meta.description || '',
        toolUseId: meta.toolUseId,
      });

      const tailer = deps.createTailer(jsonlPath);
      subagentTailers.set(key, tailer);

      tailer.on('line', (line) => {
        dispatch({
          type: 'subagent_transcript_line',
          pid: session.pid,
          subagentId,
          line,
        });

        if (line.type === 'assistant' && Array.isArray(line.message?.content)) {
          const hasToolUse = line.message.content.some((c) => c.type === 'tool_use');
          if (!hasToolUse) {
            dispatch({ type: 'subagent_ended', pid: session.pid, subagentId });
            tailer.stop();
            subagentTailers.delete(key);
            finishedSubagents.add(key);
          }
        }
      });

      tailer.start().catch(() => {});
    }
  } catch {
    // subagents dir doesn't exist yet, ignore
  }
}

// ── Poll loop ────────────────────────────────────────────────

async function poll() {
  try {
    const result = await deps.scan(scanSnapshot);
    scanSnapshot = result.snapshot;
    for (const event of result.events) dispatch(event);

    const ag = await deps.scanAg(agSnapshot);
    // The snapshot must be current before dispatch, which looks up the transcript path.
    agSnapshot = ag.snapshot;
    for (const event of ag.events) dispatch(event);

    for (const session of Object.values(office.sessions)) {
      if (session.agent !== 'claude') continue;
      await discoverSubagents(session);
    }

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
 * @param {{ onSnapshot?: (office: Office) => void, hookSocketDir?: string }}
 *   [effects] Bound on first start; snapshots flow to onSnapshot from then on,
 *   and the hook socket listens in hookSocketDir (userData — ipc.cjs passes it,
 *   keeping this module electron-free). Without a dir the socket stays closed
 *   and waiting is inferred as before.
 * @returns {Office}
 */
function start(effects = {}) {
  if (started) return office;
  started = true;
  if (effects.onSnapshot) __setDeps({ onSnapshot: effects.onSnapshot });

  // Exact real-time state via the Claude Code hook (#187). A socket failure
  // must never take the poll loop down with it — the office degrades to
  // transcript inference instead.
  try {
    hookSocket.start({ dir: effects.hookSocketDir, dispatch });
  } catch (err) {
    console.error('[office] failed to start hook socket:', err);
  }

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
  hookSocket.stop();
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
  for (const subTailer of subagentTailers.values()) subTailer.stop();
  subagentTailers.clear();
  finishedSubagents.clear();
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
  agSnapshot = antigravity.emptyAgScanSnapshot();
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
