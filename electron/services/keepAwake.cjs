'use strict';

const proc = require('child_process');

// Keep computer awake: holds a macOS sleep assertion while the user's chosen
// mode wants one.
//
//   on    — hold continuously
//   agent — hold while at least one agent Session is working
//   off   — never hold (the default)
//
// Modelled on Orca's agent-awake service. The primary hold is a supervised
// `caffeinate -i -s` child: -i blocks idle sleep, -s blocks system sleep on AC,
// and the display is still free to sleep and lock. `-w <our pid>` ties its
// lifetime to the app, so even a hard crash can't orphan an assertion that
// keeps the Mac awake forever. If caffeinate can't be spawned we fall back to
// Electron's powerSaveBlocker ('prevent-display-sleep', as Orca does); only
// one of the two is ever held.
//
// Lives in the main process alongside the ptys (ADR 0001), so it works with
// the window hidden to the tray. Electron is resolved lazily — tests import
// this module on a runner with no Electron binary.

const CAFFEINATE = '/usr/bin/caffeinate';
const MODES = ['on', 'agent', 'off'];
// An unexpected caffeinate exit is retried after this long rather than in a
// tight loop, mirroring Orca's MACOS_SYSTEM_SLEEP_ASSERTION_RETRY_MS.
const RETRY_MS = 30_000;
function fromElectron(name) {
  try {
    return require('electron')[name];
  } catch {
    return undefined;
  }
}

// Swapped in tests — vi.mock never reaches .cjs services (same seam as
// browser.cjs). An override wins even when explicitly set to undefined.
let overrides = {};

const deps = {
  get spawn() {
    return 'spawn' in overrides ? overrides.spawn : proc.spawn;
  },
  get powerSaveBlocker() {
    return 'powerSaveBlocker' in overrides
      ? overrides.powerSaveBlocker
      : fromElectron('powerSaveBlocker');
  },
  get pid() {
    return 'pid' in overrides ? overrides.pid : process.pid;
  },
  get log() {
    return 'log' in overrides ? overrides.log : console.warn;
  },
};

function __setDeps(next) {
  overrides = { ...overrides, ...next };
}

// ─── State ─────────────────────────────────────────────────────────────────

let mode = 'off';
let workingCount = 0;
let child = null; // live caffeinate process
let blockerId = null; // powerSaveBlocker id, when on the fallback
let retryTimer = null;
let exitLogged = false;
let lastPublished = null;
const listeners = new Set();

function wanted() {
  return mode === 'on' || (mode === 'agent' && workingCount > 0);
}

function held() {
  return child !== null || blockerId !== null;
}

function getStatus() {
  return { mode, active: wanted() && held(), workingCount };
}

// Republishes only when something a viewer can see actually changed.
function publish() {
  const status = getStatus();
  const key = `${status.mode}|${status.active}|${status.workingCount}`;
  if (key === lastPublished) return;
  lastPublished = key;
  for (const cb of listeners) {
    try {
      cb(status);
    } catch {}
  }
}

function onStatusChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// ─── Hold mechanics ────────────────────────────────────────────────────────

function startFallback() {
  if (blockerId !== null) return;
  const blocker = deps.powerSaveBlocker;
  if (!blocker) return;
  try {
    blockerId = blocker.start('prevent-display-sleep');
  } catch (err) {
    deps.log(`[keep-awake] powerSaveBlocker failed: ${err?.message || err}`);
    blockerId = null;
  }
}

function stopFallback() {
  if (blockerId === null) return;
  try {
    deps.powerSaveBlocker?.stop(blockerId);
  } catch {}
  blockerId = null;
}

function clearRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

function startCaffeinate() {
  let c;
  try {
    c = deps.spawn(CAFFEINATE, ['-i', '-s', '-w', String(deps.pid)], {
      stdio: 'ignore',
    });
  } catch (err) {
    deps.log(`[keep-awake] caffeinate failed to start: ${err?.message || err}`);
    startFallback();
    return;
  }
  child = c;

  // Once it is really running, the fallback (if a previous failure left one
  // up) is redundant — never hold both.
  c.once('spawn', () => {
    if (child === c) stopFallback();
    publish();
  });

  // Spawn failures (ENOENT, EACCES) arrive asynchronously as 'error'.
  c.once('error', (err) => {
    if (child !== c) return;
    child = null;
    deps.log(`[keep-awake] caffeinate failed to start: ${err?.message || err}`);
    if (wanted()) startFallback();
    publish();
  });

  c.once('exit', (code, signal) => {
    if (child !== c) return; // we killed it, or 'error' already handled it
    child = null;
    if (!wanted()) {
      publish();
      return;
    }
    if (!exitLogged) {
      deps.log(
        `[keep-awake] caffeinate exited unexpectedly (${signal || code}); retrying in ${RETRY_MS / 1000}s`
      );
      exitLogged = true;
    }
    // Keep the Mac awake through the retry window rather than leaving a gap.
    startFallback();
    clearRetry();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      apply();
    }, RETRY_MS);
    publish();
  });
}

function stopCaffeinate() {
  const c = child;
  child = null; // before kill(), so its 'exit' reads as ours, not unexpected
  if (!c) return;
  try {
    c.kill();
  } catch {}
}

function acquire() {
  // A pending retry owns the next caffeinate attempt.
  if (child || retryTimer) return;
  startCaffeinate();
}

function release() {
  clearRetry();
  stopCaffeinate();
  stopFallback();
  exitLogged = false;
}

function apply() {
  if (wanted()) acquire();
  else release();
  publish();
}

// ─── Public API ────────────────────────────────────────────────────────────

function setMode(next) {
  if (!MODES.includes(next)) return;
  mode = next;
  apply();
}

// After a wake from sleep the assertion may have been lost (caffeinate killed
// while suspended); re-applying is idempotent when everything is still held.
function handleResume() {
  apply();
}

// Releases everything. Called from before-quit; also resets state for tests.
function dispose() {
  release();
  mode = 'off';
  workingCount = 0;
  lastPublished = null;
  listeners.clear();
}

module.exports = {
  CAFFEINATE,
  MODES,
  RETRY_MS,
  setMode,
  getStatus,
  onStatusChange,
  handleResume,
  dispose,
  __setDeps,
};
