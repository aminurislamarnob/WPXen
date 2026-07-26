'use strict';

// Child-process supervisor. Service modules (nginx, php, mysql, mailpit)
// register a *spec* describing how their daemon runs in the foreground; this
// module owns the child processes: spawn, log capture, crash restart with
// backoff, graceful stop escalation, and orphan cleanup after a hard crash of
// the app itself. Replacing `brew services` with app-owned children is what
// keeps macOS "App Background Activity" down to just WPHerd.
//
// Spec shape (see each service module's buildSpec()):
//   {
//     name,                 // registry key: 'nginx' | 'php' | 'mysql' | 'mailpit'
//     bin, args, env, cwd,
//     stopSignal,           // graceful signal, default 'SIGTERM'
//     stopTimeoutMs,        // wait after stopSignal before SIGKILL (default 10s)
//     gracefulStop,         // optional async fn tried before stopSignal
//     readyProbe,           // optional async () => bool, polled after spawn
//     readyTimeoutMs,       // how long to poll readyProbe (default 10s)
//     conflictProbe,        // optional async () => bool: something already running?
//     takeover,             // optional async fn to clear an external instance
//     preSpawn,             // optional async fn run before every (re)spawn
//                           //   (e.g. sweep orphaned workers holding the port)
//     onForceKilled,        // optional cleanup after SIGKILL (e.g. orphaned workers)
//     meta,                 // free-form, surfaced in status (e.g. { version })
//   }

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Size at which a service log is rotated to `.old`. Configurable via
// Settings → Services (services.logMaxSizeMb); the default matches the
// previous hardcoded cap.
let maxLogBytes = 5 * 1024 * 1024;
function setMaxLogSizeMb(mb) {
  if (typeof mb === 'number' && Number.isFinite(mb) && mb > 0) {
    maxLogBytes = Math.round(mb * 1024 * 1024);
  }
}
const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS_PER_WINDOW = 5;
const BACKOFF_CAP_MS = 30_000;

// userData is only available inside Electron; fall back to a temp dir so the
// module stays testable with plain `node`.
let baseDir = null;
function getBaseDir() {
  if (baseDir) return baseDir;
  try {
    baseDir = require('electron').app.getPath('userData');
  } catch {
    baseDir = path.join(require('os').tmpdir(), 'wpherd-procman');
  }
  return baseDir;
}

// Test hook — lets a bare-node harness point logs/pid files somewhere safe.
function setBaseDir(dir) {
  baseDir = dir;
}

function getLogPath(name) {
  return path.join(getBaseDir(), 'logs', `${name}.log`);
}

function getPidFilePath(name) {
  return path.join(getBaseDir(), 'run', `${name}.pid`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The command line a pid is running, or null. Used to make sure we only ever
// kill processes that really are the daemon we recorded, never a recycled pid.
function pidCommand(pid) {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      stdio: 'pipe',
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

// Registry: name -> entry
//   { spec, child, state, desiredRunning, restartTimes, respawnTimer,
//     lastExitCode, error, logFd }
// state: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'
const registry = new Map();

let stateChangeCb = null;
function onStateChange(cb) {
  stateChangeCb = cb;
}

function getEntry(name) {
  if (!registry.has(name)) {
    registry.set(name, {
      spec: null,
      child: null,
      state: 'stopped',
      desiredRunning: false,
      restartTimes: [],
      respawnTimer: null,
      lastExitCode: null,
      error: null,
      logFd: null,
    });
  }
  return registry.get(name);
}

function setState(entry, name, state, error = null) {
  entry.state = state;
  entry.error = error;
  if (typeof stateChangeCb === 'function') {
    try {
      stateChangeCb(name, status(name));
    } catch {}
  }
}

function status(name) {
  const e = registry.get(name);
  if (!e) {
    return {
      state: 'stopped',
      pid: null,
      meta: null,
      restarts: 0,
      lastExitCode: null,
      error: null,
    };
  }
  return {
    state: e.state,
    pid: e.child?.pid ?? null,
    meta: e.spec?.meta ?? null,
    restarts: e.restartTimes.length,
    lastExitCode: e.lastExitCode,
    error: e.error,
  };
}

function statusAll() {
  const out = {};
  for (const name of registry.keys()) out[name] = status(name);
  return out;
}

function isSupervised(name) {
  const e = registry.get(name);
  return !!(e && e.child && e.state !== 'stopped' && e.state !== 'failed');
}

// Opens (and rotates) the service's log file, returning an append fd. Using a
// real fd for stdio (not a pipe) means daemon output can never backpressure
// the main process.
function openLogFd(name) {
  const logPath = getLogPath(name);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  try {
    const st = fs.statSync(logPath);
    if (st.size > maxLogBytes) {
      fs.renameSync(logPath, `${logPath}.old`);
    }
  } catch {}
  return fs.openSync(logPath, 'a');
}

function writePidFile(name, pid, bin) {
  const p = getPidFilePath(name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ pid, bin }), 'utf8');
}

function removePidFile(name) {
  try {
    fs.rmSync(getPidFilePath(name), { force: true });
  } catch {}
}

// Reads the tail of a service's log for error messages surfaced to the UI.
function logTail(name, bytes = 500) {
  try {
    const p = getLogPath(name);
    const st = fs.statSync(p);
    const fd = fs.openSync(p, 'r');
    const len = Math.min(bytes, st.size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    return buf.toString('utf8').trim();
  } catch {
    return '';
  }
}

// Resolves when the current child exits (immediately if there is none).
function waitForExit(entry, timeoutMs) {
  const child = entry.child;
  if (!child) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const done = (exited) => {
      if (!settled) {
        settled = true;
        resolve(exited);
      }
    };
    child.once('exit', () => done(true));
    if (!pidAlive(child.pid)) done(true);
    if (timeoutMs != null) setTimeout(() => done(false), timeoutMs);
  });
}

function clearRespawnTimer(entry) {
  if (entry.respawnTimer) {
    clearTimeout(entry.respawnTimer);
    entry.respawnTimer = null;
  }
}

// Spawns the child for an entry and wires up crash handling. Assumes spec is
// set and no live child exists.
function spawnChild(name, entry) {
  const spec = entry.spec;
  const logFd = openLogFd(name);
  entry.logFd = logFd;

  const child = spawn(spec.bin, spec.args || [], {
    env: spec.env || process.env,
    cwd: spec.cwd || undefined,
    detached: false,
    stdio: ['ignore', logFd, logFd],
  });
  entry.child = child;
  entry.lastExitCode = null;

  child.once('error', (err) => {
    // Spawn failure (bad binary path): surfaces as an immediate failed state.
    entry.child = null;
    closeLogFd(entry);
    removePidFile(name);
    entry.desiredRunning = false;
    setState(entry, name, 'failed', `Could not start ${name}: ${err.message}`);
  });

  child.once('spawn', () => {
    writePidFile(name, child.pid, spec.bin);
  });

  child.once('exit', (code, signal) => {
    entry.lastExitCode = code ?? signal ?? null;
    entry.child = null;
    closeLogFd(entry);
    removePidFile(name);

    if (entry.state === 'stopping' || !entry.desiredRunning) {
      setState(entry, name, 'stopped');
      return;
    }

    // Unexpected exit while we want it running: crash-restart with backoff,
    // giving up after too many restarts in a rolling window.
    const now = Date.now();
    entry.restartTimes = entry.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS);
    entry.restartTimes.push(now);

    if (entry.restartTimes.length > MAX_RESTARTS_PER_WINDOW) {
      entry.desiredRunning = false;
      const tail = logTail(name, 300);
      setState(
        entry,
        name,
        'failed',
        `${name} exited repeatedly (last code ${entry.lastExitCode}).` +
          (tail ? ` Log tail: ${tail.split('\n').slice(-3).join(' · ')}` : '')
      );
      return;
    }

    const backoff = Math.min(1000 * 2 ** (entry.restartTimes.length - 1), BACKOFF_CAP_MS);
    setState(entry, name, 'starting', null);
    entry.respawnTimer = setTimeout(async () => {
      entry.respawnTimer = null;
      if (entry.desiredRunning && !entry.child) {
        // A SIGKILLed master (nginx, php-fpm) leaves orphaned workers holding
        // its ports — the spec's preSpawn sweep clears them or the respawn
        // would crash-loop on "address already in use".
        if (typeof entry.spec.preSpawn === 'function') {
          try {
            await entry.spec.preSpawn();
          } catch {}
        }
        if (!entry.desiredRunning || entry.child) return;
        spawnChild(name, entry);
        // Respawn path skips the ready probe: the poller/status probes will
        // reflect reality, and a fast crash re-enters this handler anyway.
        if (entry.state === 'starting') setState(entry, name, 'running');
      }
    }, backoff);
  });

  return child;
}

function closeLogFd(entry) {
  if (entry.logFd != null) {
    try {
      fs.closeSync(entry.logFd);
    } catch {}
    entry.logFd = null;
  }
}

// Starts a service from its spec. Idempotent: a second call while starting or
// running resolves once the service is up. Throws with a human message when
// an external instance holds the service's ports and can't be taken over.
async function start(spec) {
  const name = spec.name;
  const entry = getEntry(name);

  if (entry.child && (entry.state === 'running' || entry.state === 'starting')) {
    return status(name);
  }
  clearRespawnTimer(entry);

  entry.spec = spec;
  entry.desiredRunning = true;
  entry.restartTimes = []; // manual start resets the crash-loop window
  setState(entry, name, 'starting');

  // External instance already running (manual `brew services start`, another
  // tool's daemon)? Try to clear it once, then fail with a clear message —
  // adopting a launchd-KeepAlive'd process is a fight we can't win.
  if (typeof spec.conflictProbe === 'function') {
    let conflicted = false;
    try {
      conflicted = await spec.conflictProbe();
    } catch {}
    if (conflicted && typeof spec.takeover === 'function') {
      try {
        await spec.takeover();
      } catch {}
      await sleep(2000);
      try {
        conflicted = await spec.conflictProbe();
      } catch {
        conflicted = false;
      }
    }
    if (conflicted) {
      entry.desiredRunning = false;
      setState(entry, name, 'stopped');
      throw new Error(
        `${name} is already running outside WPHerd. Stop the other instance (e.g. \`brew services stop ${name}\`) and try again.`
      );
    }
  }

  if (typeof spec.preSpawn === 'function') {
    try {
      await spec.preSpawn();
    } catch {}
  }

  spawnChild(name, entry);

  // Give an instantly-crashing daemon a moment to reveal itself so Start
  // buttons fail loudly instead of flapping in the background.
  if (typeof spec.readyProbe === 'function') {
    const deadline = Date.now() + (spec.readyTimeoutMs || 10_000);
    while (Date.now() < deadline) {
      if (entry.state === 'failed') {
        throw new Error(entry.error || `${name} failed to start.`);
      }
      try {
        if (entry.child && (await spec.readyProbe())) break;
      } catch {}
      await sleep(500);
    }
  } else {
    await sleep(500);
    if (entry.state === 'failed') {
      throw new Error(entry.error || `${name} failed to start.`);
    }
  }

  if (entry.child && entry.state === 'starting') {
    setState(entry, name, 'running');
  }
  return status(name);
}

// Stops a service: gracefulStop() → stopSignal → SIGKILL, waiting between
// steps. Resolves once the child is confirmed gone.
async function stop(name) {
  const entry = registry.get(name);
  if (!entry) return;
  entry.desiredRunning = false;
  clearRespawnTimer(entry);

  if (!entry.child) {
    if (entry.state !== 'failed') setState(entry, name, 'stopped');
    return;
  }

  const spec = entry.spec || {};
  setState(entry, name, 'stopping');

  if (typeof spec.gracefulStop === 'function') {
    try {
      await spec.gracefulStop();
      if (await waitForExit(entry, spec.stopTimeoutMs || 10_000)) return;
    } catch {
      // Fall through to signals.
    }
  }

  if (entry.child) {
    try {
      entry.child.kill(spec.stopSignal || 'SIGTERM');
    } catch {}
    if (await waitForExit(entry, spec.stopTimeoutMs || 10_000)) return;
  }

  if (entry.child) {
    try {
      entry.child.kill('SIGKILL');
    } catch {}
    await waitForExit(entry, 3000);
    if (typeof spec.onForceKilled === 'function') {
      try {
        await spec.onForceKilled();
      } catch {}
    }
  }
}

async function restart(spec) {
  await stop(spec.name);
  return start(spec);
}

// Sends a signal to a supervised child (reload semantics: SIGHUP/SIGUSR2).
function signal(name, sig) {
  const entry = registry.get(name);
  if (!entry || !entry.child) {
    throw new Error(`${name} is not running under WPHerd.`);
  }
  entry.child.kill(sig);
}

// Stops everything in parallel under one hard deadline; anything still alive
// at the deadline gets SIGKILL. Used by the app's quit path.
async function stopAll({ deadlineMs = 25_000 } = {}) {
  const names = [...registry.keys()];
  const all = Promise.all(names.map((n) => stop(n).catch(() => {})));
  const timer = sleep(deadlineMs);
  await Promise.race([all, timer]);
  for (const name of names) {
    const entry = registry.get(name);
    if (entry?.child) {
      try {
        entry.child.kill('SIGKILL');
      } catch {}
    }
  }
}

// After a hard crash of the app, previous children were reparented to launchd
// and kept running. Pid files record what we spawned; on startup, kill any
// recorded pid that is still alive AND still runs the same binary (never a
// recycled pid).
async function reconcileOrphans() {
  const runDir = path.join(getBaseDir(), 'run');
  let files = [];
  try {
    files = fs.readdirSync(runDir).filter((f) => f.endsWith('.pid'));
  } catch {
    return;
  }
  for (const file of files) {
    const p = path.join(runDir, file);
    try {
      const { pid, bin } = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (pid && pidAlive(pid)) {
        const cmd = pidCommand(pid);
        if (cmd && bin && cmd.includes(bin)) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {}
          const deadline = Date.now() + 3000;
          while (pidAlive(pid) && Date.now() < deadline) await sleep(200);
          if (pidAlive(pid)) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {}
          }
        }
      }
    } catch {}
    try {
      fs.rmSync(p, { force: true });
    } catch {}
  }
}

module.exports = {
  setMaxLogSizeMb,
  start,
  stop,
  restart,
  signal,
  stopAll,
  status,
  statusAll,
  isSupervised,
  onStateChange,
  reconcileOrphans,
  getLogPath,
  setBaseDir,
};
