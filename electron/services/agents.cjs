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
// not found.
//
// `brew` is the optional one-click install target: `{ name, cask }`, fed
// straight to `brew install [--cask] <name>`. Only entries with a package that
// actually exists in Homebrew carry one — the rest keep a text-only `install`
// hint, and the UI shows no button for them. WPXen still never installs
// anything on its own; the user has to click (Q7).
const REGISTRY = [
  {
    id: 'claude',
    name: 'Claude Code',
    cmd: 'claude',
    install: 'npm install -g @anthropic-ai/claude-code',
    brew: { name: 'claude-code', cask: true },
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
    // `antigravity-cli`, not `antigravity` — the latter is the IDE, which
    // carries `agy` but installs an .app rather than the binary. This cask's
    // artifact is `antigravity -> agy (Binary)`, i.e. the thing detection
    // looks for, so it lands straight on PATH.
    brew: { name: 'antigravity-cli', cask: true },
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
    brew: { name: 'codex', cask: true },
  },
];

// A plain login shell in the Site's directory — no agent, nothing typed. Every
// launch already spawns the user's shell and types the agent command into it
// (see `launch`), so this is that same flow with an empty command.
//
// Not a REGISTRY entry: there is no binary to detect (the login shell always
// exists), no install hint to show, and nothing to override. It is also exempt
// from the enabled filter — hiding the baseline terminal isn't a useful
// setting, and folding it into `agents.enabled` would silently hide it from
// anyone whose saved list predates it.
const SHELL_ID = 'shell';
const SHELL_AGENT = {
  id: SHELL_ID,
  name: 'Terminal',
  cmd: '',
  install: '',
  isShell: true,
};

// ── User configuration (Settings → Agents) ──────────────────────────────────
// The registry above is the default set. Users can hide agents they don't use,
// override the command a built-in agent launches with, and add their own. The
// config is injected rather than read from the store directly so this module
// stays free of electron/store imports.
let config = { enabled: null, commands: {}, custom: [] };

function setConfig(next) {
  config = {
    enabled: Array.isArray(next?.enabled) ? next.enabled : null,
    commands: next?.commands && typeof next.commands === 'object' ? next.commands : {},
    custom: Array.isArray(next?.custom) ? next.custom : [],
  };
}

// Built-ins plus user-defined agents, with per-agent command overrides applied.
// A custom entry sharing an id with a built-in replaces it.
function effectiveRegistry() {
  const byId = new Map(REGISTRY.map((a) => [a.id, a]));
  for (const entry of config.custom) {
    if (!entry?.id || !entry?.cmd) continue;
    byId.set(entry.id, {
      id: entry.id,
      name: entry.name || entry.id,
      cmd: entry.cmd,
      install: entry.install || '',
      isCustom: true,
    });
  }
  return [...byId.values()].map((a) => ({
    ...a,
    cmd: config.commands[a.id]?.trim() || a.cmd,
  }));
}

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
    const delimiter = '__WPXEN_ENV_SNAPSHOT__';
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

// The Agents offered in the launcher, each with a resolved `detected` flag and
// path (Q5/Q7). `all: true` ignores the enabled filter — Settings needs the
// full list to render its toggles.
// `agents: false` drops the providers and leaves only the plain shell; used by
// Settings → Agents, which has nothing to configure for it.
function listAgents({ all = false, shell = true } = {}) {
  const env = resolveShellEnv();
  const providers = effectiveRegistry()
    .filter((a) => all || !config.enabled || config.enabled.includes(a.id))
    // A command override can carry arguments ('claude --resume'); only the
    // first token is a binary to detect on PATH.
    .map((a) => {
      const bin = resolveBin(a.cmd.split(/\s+/)[0], env);
      return {
        id: a.id,
        name: a.name,
        cmd: a.cmd,
        install: a.install,
        // Present only when a one-click Homebrew install is available; the UI
        // keys the Install button off this.
        brew: a.brew ? { ...a.brew } : null,
        isCustom: !!a.isCustom,
        isShell: false,
        enabled: !config.enabled || config.enabled.includes(a.id),
        detected: Boolean(bin),
        path: bin,
      };
    });

  if (!shell) return providers;

  // Last: it's the baseline, but providers are more useful to surface first.
  return [
    ...providers,
    {
      ...SHELL_AGENT,
      brew: null,
      isCustom: false,
      enabled: true,
      detected: true,
      path: getUserShell(),
    },
  ];
}

// ── One-click install ────────────────────────────────────────────────────────
// Homebrew is the only installer WPXen drives. npm-global hints stay text-only:
// a `npm install -g` needs a node version WPXen doesn't manage and writes
// outside the Homebrew prefix, so there is no sane way to undo it — brew has
// `uninstall`, an audit trail, and is already the app's dependency channel.
//
// brew.cjs is required lazily so this module stays importable outside Electron
// (brew.cjs itself is safe, but the seam below is what tests swap).
const deps = {
  runBrewStreaming: (args, onProgress) =>
    require('./brew.cjs').runBrewStreaming(args, onProgress),
  isBrewInstalled: () => require('./brew.cjs').isBrewInstalled(),
};

function __setDeps(next) {
  Object.assign(deps, next);
}

// Builds the brew argv for an Agent's package. Pure, so the arg shape is
// testable without spawning anything.
function brewInstallArgs(target) {
  if (!target || typeof target.name !== 'string' || !target.name.trim()) {
    throw new Error('No Homebrew package for this agent');
  }
  // The name is ours, not user input — but it lands in an argv, so refuse
  // anything that isn't a plain formula/cask token rather than trusting the
  // registry to stay well-formed forever.
  if (!/^[a-z0-9][a-z0-9@/._-]*$/i.test(target.name)) {
    throw new Error(`Invalid Homebrew package name: ${target.name}`);
  }
  return target.cask ? ['install', '--cask', target.name] : ['install', target.name];
}

// Installs an Agent's CLI via Homebrew, streaming brew's output line by line.
// Resolves once brew exits 0; the caller re-runs listAgents to pick up the new
// binary (detection is a live PATH probe, so nothing needs invalidating).
async function installAgent(id, onProgress) {
  const agent = effectiveRegistry().find((a) => a.id === id);
  if (!agent) throw new Error(`Unknown agent: ${id}`);
  if (!agent.brew) {
    throw new Error(
      `${agent.name} has no Homebrew package — install it with: ${agent.install}`
    );
  }
  if (!deps.isBrewInstalled()) {
    throw new Error('Homebrew is not installed');
  }
  await deps.runBrewStreaming(brewInstallArgs(agent.brew), onProgress);
}

// ── Launch resolution (Launch Presets & Targets) ─────────────────────────────
// A launch is more than "the provider name". Two axes shape it, kept
// deliberately small (see the Superset preset analysis — we take the two that
// earn their keep and leave the workspace/automation machinery alone):
//
//   • command / flags — usually stable per provider, so they live as a GLOBAL
//     default per Agent (e.g. `claude --dangerously-skip-permissions`).
//   • directory — varies per Site (a plugin/theme subfolder, a git worktree),
//     so a Site owns a LIST of saved Targets, each pinning a cwd.
//
// `resolveLaunch` is a pure function of primitives — no store, no fs — so it is
// trivially unit-testable and both callers (default launch, saved Target) go
// through the same rules:
//
//   args : target.args when set (incl. "" = explicit none) else the global
//          default. `null`/`undefined` on a Target means "inherit global".
//   cwd  : target.cwd absolute → as-is; relative → resolved against the
//          webroot (so `../feature-worktree` and `wp-content/plugins/foo` both
//          work); absent → the webroot itself.
//
// A plain-shell launch passes `cmd: ''`, so `command` collapses to the args
// alone — or to '' when there are none, which `launch` reads as "type nothing".
function resolveLaunch({ cmd, sitePath, globalArgs = '', target = null }) {
  const rawArgs = target && target.args != null ? target.args : globalArgs || '';
  const args = String(rawArgs).trim();
  const command = [String(cmd || '').trim(), args].filter(Boolean).join(' ');

  let cwd = sitePath;
  if (target && target.cwd) {
    cwd = path.isAbsolute(target.cwd)
      ? path.normalize(target.cwd)
      : path.resolve(sitePath, target.cwd);
  }

  return { command, cwd, label: target?.label || null };
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
      out.push({
        sessionId: s.sessionId,
        agentId: s.agentId,
        agentName: s.agentName,
        targetId: s.targetId,
        label: s.label,
      });
    }
  }
  return out;
}

// Launch an Agent for a Site. Always creates a NEW Session so multiple can run
// per directory. `target` (a saved Launch Target) and `globalArgs` (the Agent's
// global default flags) are optional; both flow through `resolveLaunch` to
// decide the cwd and the command line typed into the shell.
// Returns { ok, sessionId } or { error }.
function launch({ site, agentId, target = null, globalArgs = '' }) {
  // `all` so launching by id still works for an agent hidden from the
  // launcher (e.g. a saved session being restored).
  const agent = listAgents({ all: true }).find((a) => a.id === agentId);
  if (!agent) return { error: `Unknown agent: ${agentId}` };
  // The shell is always present, so this only ever rejects a missing provider.
  if (!agent.detected) return { error: `${agent.name} is not installed` };

  const { command, cwd, label } = resolveLaunch({
    cmd: agent.cmd,
    sitePath: site.path,
    globalArgs,
    target,
  });

  // A Target's directory can go stale (a deleted worktree, a moved plugin).
  // Fail loudly before spawning a shell in a bad cwd rather than dropping the
  // user into their home dir with no explanation.
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory');
  } catch {
    return { error: `Directory not found: ${cwd}` };
  }

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
      cwd,
      env: {
        ...env,
        TERM: 'xterm-256color',
        TERM_PROGRAM: 'WPXen',
        // Suppress oh-my-zsh's auto-update check. It fires during rc sourcing and
        // blocks on an interactive `[Y/n]` prompt (a single-char `read`); the
        // settle-window that types the agent command can't reliably out-wait it,
        // so the first char gets eaten by the prompt and the rest runs as a bad
        // command. `DISABLE_AUTO_UPDATE=true` maps to omz `update_mode=disabled`,
        // so the prompt never appears. Only affects this agent shell.
        DISABLE_AUTO_UPDATE: 'true',
      },
    });
  } catch (err) {
    return { error: `Failed to launch ${agent.name}: ${err.message}` };
  }

  // A plain shell has nothing to type — the pty is already what was asked for.
  const startsImmediately = !command;

  const session = {
    sessionId,
    siteId: site.id,
    agentId: agent.id,
    agentName: agent.name,
    targetId: target?.id || null,
    label,
    cwd,
    pty: term,
    buffer: '',
    window: null,
    exited: false,
    // `started` gates the type-the-command step; a shell session has already
    // arrived at what the user wanted, so it starts out done.
    started: startsImmediately,
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
      term.write(`${command}\r`);
    } catch {}
  };
  const scheduleRun = () => {
    if (session.started || settleTimer) return;
    settleTimer = setTimeout(runAgent, 150);
  };
  if (!startsImmediately) setTimeout(runAgent, 1200); // fallback: no output first

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
  SHELL_ID,
  setConfig,
  effectiveRegistry,
  listAgents,
  installAgent,
  brewInstallArgs,
  listSessions,
  resolveLaunch,
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
  __setDeps,
};
