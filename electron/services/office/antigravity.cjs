'use strict';

// ── Antigravity adapter ──────────────────────────────────────
// One-time faithful port of claude-agent-verse packages/server/src/antigravity.ts
// (replay mode dropped — WPXen does not port the replay harness).
//
// Antigravity (the 2.0 app / Agent Manager, the IDE and the CLI) keeps one
// folder per conversation at
//   ~/.gemini/<root>/brain/<conversationId>/
// with a step-per-line transcript at .system_generated/logs/transcript.jsonl.
//
// There is no per-process registry like Claude Code's, so a conversation
// counts as live while its transcript keeps being written, and gets a
// synthetic negative id in place of a pid (stable for as long as the engine
// runs).
//
// ⚠️ Guardrail the spec depends on: ~/.gemini also holds OAuth credentials and
// settings. Only brain folder names are listed (readdir of <home>/<root>/brain)
// and only the fixed transcript.jsonl path is ever stat'ed or opened — nothing
// else in that tree is touched. The ANTIGRAVITY_HOME env override is the test
// seam. Electron-free: plain node APIs only.

const { readdir, stat } = require('node:fs/promises');
const { dirname, extname, isAbsolute, join, relative } = require('node:path');
const { homedir } = require('node:os');

/** @typedef {import('./types.cjs').DomainEvent} DomainEvent */

/** Antigravity 2.0 / Agent Manager, the original IDE, and the CLI each keep their own brain. */
const BRAIN_ROOTS = ['antigravity', 'antigravity-ide', 'antigravity-cli'];
/** A conversation whose transcript has not changed for this long has left the office. */
const AG_LIVE_MS = 30 * 60_000;
/** Pod for conversations whose workspace is not known yet. */
const UNKNOWN_PROJECT = 'antigravity';

/**
 * Live conversations from the last scan, keyed by conversation id.
 * @typedef {Object} AgScanSnapshot
 * @property {Map<string, { pid: number, transcriptPath: string, startedAt: number }>} conversations
 * @property {number} nextPid Next synthetic id to hand out: -1, -2, …
 */

/** @returns {AgScanSnapshot} */
function emptyAgScanSnapshot() {
  return { conversations: new Map(), nextPid: -1 };
}

/**
 * The Antigravity home directory. ANTIGRAVITY_HOME overrides it (the test seam).
 * @returns {string}
 */
function antigravityHome() {
  return process.env.ANTIGRAVITY_HOME ?? join(homedir(), '.gemini');
}

/**
 * List the brain folders and emit domain events for conversations that started
 * or stopped being written since the previous snapshot.
 * @param {AgScanSnapshot} prev
 * @param {number} [now]
 * @returns {Promise<{ events: DomainEvent[], snapshot: AgScanSnapshot }>}
 */
async function scanAntigravity(prev, now = Date.now()) {
  /** @type {DomainEvent[]} */
  const events = [];
  /** @type {AgScanSnapshot} */
  const next = { conversations: new Map(), nextPid: prev.nextPid };

  for (const root of BRAIN_ROOTS) {
    const brain = join(antigravityHome(), root, 'brain');
    let ids;
    try {
      ids = await readdir(brain);
    } catch {
      continue; // this Antigravity surface isn't installed
    }
    for (const id of ids) {
      // A duplicated id in two roots is counted once — the first root wins.
      if (next.conversations.has(id)) continue;
      const transcriptPath = join(
        brain,
        id,
        '.system_generated',
        'logs',
        'transcript.jsonl'
      );
      const st = await stat(transcriptPath).catch(() => null);
      // A brain folder without a transcript yet is not a conversation.
      if (!st?.isFile()) continue;
      if (now - st.mtimeMs > AG_LIVE_MS) continue;

      const known = prev.conversations.get(id);
      if (known) {
        next.conversations.set(id, known);
        continue;
      }
      const conversation = {
        pid: next.nextPid--,
        transcriptPath,
        startedAt: Math.round(st.birthtimeMs || st.mtimeMs),
      };
      next.conversations.set(id, conversation);
      events.push({
        type: 'session_appeared',
        agent: 'antigravity',
        pid: conversation.pid,
        sessionId: id,
        cwd: '',
        name: `agy-${id.slice(0, 8)}`,
        projectKey: UNKNOWN_PROJECT,
        startedAt: conversation.startedAt,
      });
    }
  }

  for (const [id, conversation] of prev.conversations) {
    if (!next.conversations.has(id))
      events.push({ type: 'session_ended', pid: conversation.pid });
  }
  return { events, snapshot: next };
}

// ── Workspace ────────────────────────────────────────────────
// The transcript names no working directory, so it is taken from the first
// absolute path a tool call works on (toolPathFromStep), then resolved to a
// folder on disk (workspaceDir). Directory-like arguments win over file paths.

const PATH_KEYS = [
  'Cwd',
  'DirectoryPath',
  'SearchDirectory',
  'SearchPath',
  'AbsolutePath',
  'TargetFile',
];

/**
 * @param {string} key
 * @returns {number}
 */
function rank(key) {
  const i = PATH_KEYS.indexOf(key);
  return i < 0 ? PATH_KEYS.length : i;
}

/**
 * @param {*} call
 * @returns {Record<string, unknown> | null}
 */
function argsOf(call) {
  let args = call?.args ?? call?.arguments ?? call?.parameters;
  if (typeof args === 'string') {
    // Tool args are sometimes serialized as a JSON string.
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  return args && typeof args === 'object' ? args : null;
}

/**
 * @param {string} dir
 * @param {string} path
 * @returns {boolean}
 */
function isInside(dir, path) {
  const r = relative(dir, path);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/**
 * The absolute path a step's tool call works on, or undefined when it names none.
 * @param {*} step
 * @returns {string | undefined}
 */
function toolPathFromStep(step) {
  if (!step || !Array.isArray(step.tool_calls)) return undefined;
  const home = antigravityHome();
  for (const call of step.tool_calls) {
    const args = argsOf(call);
    if (!args) continue;
    const paths = Object.entries(args)
      .filter((e) => typeof e[1] === 'string' && isAbsolute(e[1]))
      // Antigravity keeps its own plans and task lists in the brain folder; that isn't the workspace.
      .filter(([, p]) => !isInside(home, p))
      .sort(([a], [b]) => rank(a) - rank(b));
    if (paths.length) return paths[0][1];
  }
  return undefined;
}

/**
 * The folder a tool-call path works in: the path itself when it is a
 * directory, else its parent. The disk decides, so a `Makefile` or `.env` is a
 * file and `acme.app` a folder. A path that does not exist yet (a file about
 * to be written) resolves to its nearest existing ancestor; one that is not on
 * this machine at all is read by name.
 * @param {string} path
 * @returns {Promise<string>}
 */
async function workspaceDir(path) {
  for (let p = path; ;) {
    const st = await stat(p).catch(() => null);
    if (st) return st.isDirectory() ? p : dirname(p);
    const parent = dirname(p);
    // Only the root is left: nothing of this path is on this machine.
    if (dirname(parent) === parent) break;
    p = parent;
  }
  return extname(path) ? dirname(path) : path;
}

module.exports = {
  BRAIN_ROOTS,
  AG_LIVE_MS,
  UNKNOWN_PROJECT,
  antigravityHome,
  emptyAgScanSnapshot,
  scanAntigravity,
  toolPathFromStep,
  workspaceDir,
};
