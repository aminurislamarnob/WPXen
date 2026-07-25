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
    // command-code installs four aliases for one entry point: cmd, cmdc,
    // command-code, commandcode. `cmd` is the short one users type, but it's
    // generic enough that an unrelated binary could shadow it — switch to
    // `command-code` if that ever turns into a false positive.
    id: 'commandcode',
    name: 'Command Code',
    cmd: 'cmd',
    install: 'npm install -g command-code',
  },
  // Antigravity and MiMo Code ship as standalone binaries rather than npm
  // globals, so `install` describes the source instead of giving a
  // copy-pasteable command. They also land outside the usual bin dirs
  // (~/.local/bin, ~/.mimocode/bin), which detection handles fine —
  // resolveShellEnv snapshots the login shell's PATH, so anything the user's
  // rc files add is visible here too.
  {
    id: 'antigravity',
    name: 'Antigravity',
    cmd: 'agy',
    install: 'Bundled with the Antigravity IDE',
  },
  {
    id: 'mimo',
    name: 'MiMo Code',
    cmd: 'mimo',
    install: 'Install the MiMo Code CLI',
  },
  {
    id: 'codex',
    name: 'Codex',
    cmd: 'codex',
    install: 'npm install -g @openai/codex',
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
// A Site may host MANY concurrent Sessions (any mix of Agents, incl. several of
// the same provider). Sessions are therefore keyed by a unique sessionId, not by
// siteId; each carries its own pty + ring buffer.
const { randomUUID } = require('crypto');
const MAX_BUFFER = 1024 * 1024; // ~1 MB ring buffer (Q9)
const sessions = new Map(); // sessionId -> session

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

// The live Sessions for a Site, oldest first — used to restore terminal tabs.
function listSessions(siteId) {
  const out = [];
  for (const s of sessions.values()) {
    if (s.siteId === siteId && !s.exited) {
      out.push({ sessionId: s.sessionId, agentId: s.agentId, agentName: s.agentName });
    }
  }
  return out;
}

// Launch an Agent for a Site. Always creates a NEW Session so multiple can run
// per directory. Returns { ok, sessionId } or { error }.
function launch({ site, agentId }) {
  const agent = listAgents().find((a) => a.id === agentId);
  if (!agent) return { error: `Unknown agent: ${agentId}` };
  if (!agent.detected) return { error: `${agent.name} is not installed` };

  const sessionId = randomUUID();
  const env = resolveShellEnv();
  // Spawn the user's interactive login SHELL — not the agent binary directly —
  // and type the agent command into it. Exiting the agent CLI then drops back to
  // a normal shell prompt (like Superset), and the Session only ends when the
  // shell itself exits. `-il` sources the user's rc files.
  const shell = getUserShell();
  let term;
  try {
    term = pty.spawn(shell, ['-il'], {
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
    sessionId,
    siteId: site.id,
    agentId: agent.id,
    agentName: agent.name,
    pty: term,
    buffer: '',
    window: null,
    exited: false,
    started: false,
  };
  sessions.set(sessionId, session);

  // Run the agent once the shell is ready: wait a short settle window after the
  // first output (so rc files that print during init don't swallow the typed
  // command), with an absolute fallback if the shell prints nothing first.
  let settleTimer = null;
  const runAgent = () => {
    if (session.started || session.exited) return;
    session.started = true;
    try {
      term.write(`${agent.cmd}\r`);
    } catch {}
  };
  const scheduleRun = () => {
    if (session.started || settleTimer) return;
    settleTimer = setTimeout(runAgent, 150);
  };
  setTimeout(runAgent, 1200); // fallback: no output before the prompt

  term.onData((data) => {
    scheduleRun();
    session.buffer += data;
    if (session.buffer.length > MAX_BUFFER) {
      session.buffer = session.buffer.slice(session.buffer.length - MAX_BUFFER);
    }
    const win = session.window;
    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal-data', { sessionId, data });
    }
  });

  term.onExit(({ exitCode }) => {
    session.exited = true;
    const win = session.window;
    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal-exit', { sessionId, code: exitCode });
    }
  });

  return { ok: true, sessionId };
}

// Bind a Terminal Window to its Session and replay the ring buffer (Q9). Setting
// the window ref and sending replay happen synchronously, so no onData chunk can
// interleave between them — live chunks that follow arrive after the replay.
function attach(sessionId, win) {
  const session = sessions.get(sessionId);
  if (!session) return { error: 'no session' };
  session.window = win;
  win.webContents.send('terminal-replay', {
    sessionId,
    data: session.buffer,
    exited: session.exited,
  });
  return { ok: true };
}

function write(sessionId, data) {
  const session = sessions.get(sessionId);
  if (session && !session.exited) session.pty.write(data);
}

// Clear a Session's ring buffer so a later reattach doesn't replay content the
// user cleared with Cmd+K. No-op if the session is gone.
function clearBuffer(sessionId) {
  const session = sessions.get(sessionId);
  if (session) session.buffer = '';
}

function resize(sessionId, cols, rows) {
  const session = sessions.get(sessionId);
  if (session && !session.exited && cols > 0 && rows > 0) {
    try {
      session.pty.resize(cols, rows);
    } catch {}
  }
}

// Graceful stop: SIGTERM, escalate to SIGKILL after a grace period (Q11).
function stop(sessionId) {
  const session = sessions.get(sessionId);
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
  sessions.delete(sessionId);
}

function hasActiveSessions() {
  for (const s of sessions.values()) if (!s.exited) return true;
  return false;
}

// Distinct Site ids that have a live Session — for the quit-confirmation dialog.
function activeSiteIds() {
  const ids = new Set();
  for (const s of sessions.values()) if (!s.exited) ids.add(s.siteId);
  return [...ids];
}

function stopAll() {
  for (const sessionId of [...sessions.keys()]) stop(sessionId);
}

module.exports = {
  listAgents,
  listSessions,
  launch,
  attach,
  write,
  clearBuffer,
  resize,
  stop,
  getSession,
  hasActiveSessions,
  activeSiteIds,
  stopAll,
};
