'use strict';

// Agent Launcher — see CONTEXT.md and docs/adr/0001-main-process-pty-no-daemon.md.
//
// Runs an AI-provider CLI ("Agent") in a pseudo-terminal ("Session") rooted at a
// Site's webroot. One Session per Site. The pty lives in THIS (main) process —
// no daemon — so it survives the window hiding to the tray and is reaped on quit.
// Reattach after a window reopen is served from an in-memory ring buffer.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const pty = require('node-pty');

// ── Registry ────────────────────────────────────────────────────────────────
// Curated, data-shaped so user-defined Agents can drop in later (Q5). `cmd` is
// the binary we detect on PATH and spawn; `install` is the hint shown when it's
// not found (Q7 — we don't auto-install).
const REGISTRY = [
  {
    id: 'claude',
    name: 'Claude Code',
    cmd: 'claude',
    install: 'npm install -g @anthropic-ai/claude-code',
  },
  {
    id: 'codex',
    name: 'Codex',
    cmd: 'codex',
    install: 'npm install -g @openai/codex',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    cmd: 'gemini',
    install: 'npm install -g @google/gemini-cli',
  },
  {
    id: 'opencode',
    name: 'opencode',
    cmd: 'opencode',
    install: 'npm install -g opencode-ai',
  },
];

// ── Login-shell environment snapshot (Q6) ────────────────────────────────────
// Electron launches from launchd with a stripped PATH, so agent binaries (npm
// globals, Homebrew, pipx) aren't visible. Resolve the user's real login-shell
// environment once and cache it — the approach borrowed from Superset's
// host-service terminal env. cwd is the only project scoping; no PHP injection.
let cachedEnv = null;

// Prefer the OS account shell over the inherited $SHELL: a GUI-launched helper
// often inherits a generic /bin/bash even when the user's login shell is zsh.
function getUserShell() {
  try {
    const accountShell = os.userInfo().shell;
    if (typeof accountShell === 'string' && accountShell.trim()) {
      return accountShell.trim();
    }
  } catch {}
  return process.env.SHELL || '/bin/zsh';
}

function resolveShellEnv() {
  if (cachedEnv) return cachedEnv;

  let env = { ...process.env };
  try {
    const shell = getUserShell();
    const delimiter = '__WPHERD_ENV_SNAPSHOT__';
    // -ilc: interactive login shell so it sources the user's rc files, then dump
    // env between markers. stdin ignored so the interactive shell can't block.
    const out = execFileSync(
      shell,
      ['-ilc', `echo ${delimiter}; env; echo ${delimiter}`],
      { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const start = out.indexOf(delimiter);
    const end = out.lastIndexOf(delimiter);
    if (start !== -1 && end > start) {
      const block = out.slice(start + delimiter.length, end);
      const snapshot = {};
      for (const line of block.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) snapshot[line.slice(0, eq)] = line.slice(eq + 1);
      }
      if (snapshot.PATH) env = snapshot;
    }
  } catch {
    // Degraded PTY env beats a broken feature — fall back to process.env.
  }

  // Belt-and-suspenders: make sure the common macOS bin dirs are on PATH even if
  // the probe came up short.
  const extras = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  const parts = (env.PATH || '').split(':').filter(Boolean);
  for (const dir of extras) if (!parts.includes(dir)) parts.push(dir);
  env.PATH = parts.join(':');

  cachedEnv = env;
  return cachedEnv;
}

// Resolve an executable against the snapshot PATH. Returns absolute path or null.
function resolveBin(cmd, env) {
  for (const dir of (env.PATH || '').split(':')) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

// The registry with a resolved `detected` flag + path for each Agent (Q5/Q7).
function listAgents() {
  const env = resolveShellEnv();
  return REGISTRY.map((a) => {
    const bin = resolveBin(a.cmd, env);
    return {
      id: a.id,
      name: a.name,
      cmd: a.cmd,
      install: a.install,
      detected: Boolean(bin),
      path: bin,
    };
  });
}

// ── Sessions ─────────────────────────────────────────────────────────────────
const MAX_BUFFER = 1024 * 1024; // ~1 MB ring buffer (Q9)
const sessions = new Map(); // siteId -> session

function getSession(siteId) {
  return sessions.get(siteId) || null;
}

function status(siteId) {
  const s = sessions.get(siteId);
  return s && !s.exited
    ? { running: true, agentId: s.agentId, agentName: s.agentName }
    : { running: false };
}

// Launch an Agent for a Site. Idempotent-ish: if a live Session already exists we
// keep it (the caller focuses its window). Returns { ok } or { error }.
function launch({ site, agentId }) {
  const existing = sessions.get(site.id);
  if (existing && !existing.exited) {
    return { ok: true, alreadyRunning: true };
  }

  const agent = listAgents().find((a) => a.id === agentId);
  if (!agent) return { error: `Unknown agent: ${agentId}` };
  if (!agent.detected) return { error: `${agent.name} is not installed` };

  const env = resolveShellEnv();
  let term;
  try {
    term = pty.spawn(agent.path, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: site.path,
      env: { ...env, TERM: 'xterm-256color', TERM_PROGRAM: 'WPHerd' },
    });
  } catch (err) {
    return { error: `Failed to launch ${agent.name}: ${err.message}` };
  }

  const session = {
    siteId: site.id,
    agentId: agent.id,
    agentName: agent.name,
    pty: term,
    buffer: '',
    window: null,
    exited: false,
  };
  sessions.set(site.id, session);

  term.onData((data) => {
    session.buffer += data;
    if (session.buffer.length > MAX_BUFFER) {
      session.buffer = session.buffer.slice(session.buffer.length - MAX_BUFFER);
    }
    const win = session.window;
    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal-data', { siteId: site.id, data });
    }
  });

  term.onExit(({ exitCode }) => {
    session.exited = true;
    const win = session.window;
    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal-exit', { siteId: site.id, code: exitCode });
    }
  });

  return { ok: true };
}

// Bind a Terminal Window to its Session and replay the ring buffer (Q9). Setting
// the window ref and sending replay happen synchronously, so no onData chunk can
// interleave between them — live chunks that follow arrive after the replay.
function attach(siteId, win) {
  const session = sessions.get(siteId);
  if (!session) return { error: 'no session' };
  session.window = win;
  win.webContents.send('terminal-replay', {
    siteId,
    data: session.buffer,
    exited: session.exited,
  });
  return { ok: true };
}

function write(siteId, data) {
  const session = sessions.get(siteId);
  if (session && !session.exited) session.pty.write(data);
}

function resize(siteId, cols, rows) {
  const session = sessions.get(siteId);
  if (session && !session.exited && cols > 0 && rows > 0) {
    try {
      session.pty.resize(cols, rows);
    } catch {}
  }
}

// Graceful stop: SIGTERM, escalate to SIGKILL after a grace period (Q11).
function stop(siteId) {
  const session = sessions.get(siteId);
  if (!session) return;
  if (!session.exited) {
    try {
      session.pty.kill('SIGTERM');
    } catch {}
    const term = session.pty;
    setTimeout(() => {
      if (!session.exited) {
        try {
          term.kill('SIGKILL');
        } catch {}
      }
    }, 3000);
  }
  sessions.delete(siteId);
}

function hasActiveSessions() {
  for (const s of sessions.values()) if (!s.exited) return true;
  return false;
}

// Names of Sites with a live Session — for the quit-confirmation dialog (Q11).
function activeSiteIds() {
  const ids = [];
  for (const [siteId, s] of sessions.entries()) if (!s.exited) ids.push(siteId);
  return ids;
}

function stopAll() {
  for (const siteId of [...sessions.keys()]) stop(siteId);
}

module.exports = {
  listAgents,
  status,
  launch,
  attach,
  write,
  resize,
  stop,
  getSession,
  hasActiveSessions,
  activeSiteIds,
  stopAll,
};
