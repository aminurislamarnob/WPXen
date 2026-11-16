'use strict';

// Agent Launcher — see CONTEXT.md and docs/adr/0001-main-process-pty-no-daemon.md.
//
// Runs an AI-provider CLI ("Agent") in a pseudo-terminal ("Session") rooted at a
// Site's webroot. A Site may host many Sessions. The pty lives in THIS (main) process —
// no daemon — so it survives the window hiding to the tray and is reaped on quit.
// Reattach after a window reopen is served from an in-memory ring buffer.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createTracker, createNotifier, isTerminalReply } = require('./agentStatus.cjs');
const {
  createInAppTerminalProvider,
  defaultSpawnPty,
} = require('./terminalProvider.cjs');
const {
  historyDir,
  readHistory,
  deleteHistory,
  pruneOrphanedHistory,
} = require('./sessionHistory.cjs');
const shellIntegration = require('./shellIntegration.cjs');

// ── Registry ────────────────────────────────────────────────────────────────
// Curated, data-shaped so user-defined Agents can drop in later (Q5). `cmd` is
// the command typed into the session — binary plus any default flags — and
// `install` is the hint shown when it's not found. Only the FIRST token is
// detected on PATH, which is what lets `cmd` carry flags at all.
//
// The `--dangerously-*` flags are deliberate: WPXen drives these agents inside
// a local dev site the user already owns, and stopping at an approval prompt
// on every file write makes the pane useless. They are defaults, not a policy
// — Settings → Agents → Launch Commands overrides any of them per agent.
//
// `installer` is the optional one-click install target, tagged by kind:
//
//   { kind: 'brew', name, cask }  → brew install [--cask] <name>
//   { kind: 'npm', package }      → npm install -g <package>
//   { kind: 'script', url }       → the vendor's install script, over https
//
// Prefer 'brew' whenever a package exists: it is undoable, auditable, and
// already the app's dependency channel. The other two are for CLIs shipped no
// other way, and each carries a caveat the UI states rather than hides — an
// npm global lives in the active node version's prefix and cannot be undone
// from here, and a script executes vendor code fetched over the network.
// Entries with none of the three keep a text-only `install` hint and get no
// button. WPXen still never installs anything on its own; the user clicks (Q7).
const REGISTRY = [
  {
    id: 'claude',
    name: 'Claude Code',
    cmd: 'claude --dangerously-skip-permissions',
    install: 'npm install -g @anthropic-ai/claude-code',
    installer: { kind: 'brew', name: 'claude-code', cask: true },
    // A fresh Session opens exactly as typing `claude` would — no
    // `--session-id` — and its conversation id is read afterwards from
    // Claude's own ~/.claude/sessions/<pid>.json (claudeRegistry.cjs).
    sessionRegistry: true,
    resumeFlag: '--resume',
    chat: 'claude',
    ask: { kind: 'claude-digits' },
    // Aliases Claude Code's `/model` accepts, as shown in its TUI picker.
    // The chat view builds its model picker from this; no table hides it.
    models: [
      { id: 'opus', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'haiku', label: 'Haiku' },
    ],
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
    // npm-only — no Homebrew package exists (searched: only unrelated hits).
    // Pinned to @latest so a click always gets the current release rather than
    // silently satisfying itself with a stale cached version.
    installer: { kind: 'npm', package: 'command-code@latest' },
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
    cmd: 'agy --dangerously-skip-permissions',
    install: 'Bundled with the Antigravity IDE',
    // `antigravity-cli`, not `antigravity` — the latter is the IDE, which
    // carries `agy` but installs an .app rather than the binary. This cask's
    // artifact is `antigravity -> agy (Binary)`, i.e. the thing detection
    // looks for, so it lands straight on PATH.
    installer: { kind: 'brew', name: 'antigravity-cli', cask: true },
    promptFlag: '-i',
    chat: 'antigravity',
    // Mapped per working folder only once a conversation exists — keep
    // locating until one shows up, like Codex.
    lateBind: true,
  },
  {
    id: 'mimo',
    name: 'MiMo Code',
    cmd: 'mimo',
    install: 'curl -fsSL https://mimo.xiaomi.com/install | bash',
    // No Homebrew package exists. The vendor script needs no sudo, installs to
    // ~/.mimocode/bin, and appends a PATH line to the user's shell rc — which
    // is what makes `mimo` detectable afterwards, so we let it (the UI says so
    // rather than doing it quietly).
    installer: { kind: 'script', url: 'https://mimo.xiaomi.com/install' },
  },
  {
    id: 'copilot',
    name: 'Copilot',
    cmd: 'copilot --allow-tool=write',
    install: 'npm install -g @github/copilot',
    // A `copilot-cli` cask also exists and its artifact is the `copilot`
    // binary, so it would work here — npm is the vendor's documented channel
    // and what this entry was specified as. Switching to
    // { kind: 'brew', name: 'copilot-cli', cask: true } is a one-line change
    // if the npm global's node-version tie ever becomes a support burden.
    installer: { kind: 'npm', package: '@github/copilot' },
  },
  {
    id: 'grok',
    name: 'Grok',
    cmd: 'grok --always-approve',
    install: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    // No Homebrew package — the `grok` formula in core is an unrelated regex
    // tool (and deprecated), so installing it would shadow this CLI's name
    // with something that isn't it. Vendor script only.
    installer: { kind: 'script', url: 'https://x.ai/cli/install.sh' },
  },
  {
    id: 'cursor',
    name: 'Cursor Agent',
    cmd: 'cursor-agent',
    install: 'curl https://cursor.com/install -fsS | bash',
    // No Homebrew package. Installs to ~/.local/bin and appends a PATH line to
    // the shell rc, same shape as MiMo's.
    installer: { kind: 'script', url: 'https://cursor.com/install' },
  },
  {
    id: 'codex',
    name: 'Codex',
    cmd: 'codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust',
    install: 'npm install -g @openai/codex',
    installer: { kind: 'brew', name: 'codex', cask: true },
    chat: 'codex',
    // No session-id flag: the rollout appears after the first message, so
    // the chat view keeps locating until one shows up.
    lateBind: true,
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
      promptFlag: entry.promptFlag || null,
      isCustom: true,
    });
  }
  return [...byId.values()].map((a) => ({
    ...a,
    cmd: config.commands[a.id]?.trim() || a.cmd,
    // What `cmd` would be with no override. Settings shows it as the field's
    // placeholder and as what Reset restores — reading that off `cmd` would
    // echo the override back as if it were the default.
    defaultCmd: a.cmd,
  }));
}

// ── Login-shell environment snapshot (Q6) ────────────────────────────────────
// Electron launches from launchd with a stripped PATH, so agent binaries (npm
// globals, Homebrew, pipx) aren't visible. Resolve the user's real login-shell
// environment once and cache it — the approach borrowed from Superset's
// host-service terminal env. Project scoping is the cwd plus, for a Site's
// Sessions, its PHP version first on PATH (startSession, shellIntegration.cjs).
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

// The variables a running Claude Code session exports to its own children.
// WPXen inherits them whenever it is launched from inside one (`npm run dev`
// typed in a Claude terminal, or run by an agent), and every Session's pty
// would then pass them on. A Claude Code that sees CLAUDE_CODE_CHILD_SESSION
// believes it is a sub-process of that other session and turns transcript
// saving off ("Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION
// marker"), so no transcript is ever written and the chat view stays empty.
// The rest point it at the parent's messaging socket and session id. Only
// these session-identity markers are dropped; user configuration such as
// CLAUDE_CODE_USE_BEDROCK or CLAUDE_CONFIG_DIR passes through untouched.
const PARENT_AGENT_ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PID',
];

function stripParentAgentEnv(env) {
  const out = { ...env };
  for (const key of PARENT_AGENT_ENV_KEYS) delete out[key];
  return out;
}

// Some tools put a launcher of their own on PATH under the *agent's* name — a
// small shell script that finds the real binary elsewhere on PATH and execs it,
// and prints an error if there isn't one. Superset does this for a dozen agent
// names in ~/.superset/bin.
//
// Such a shim is executable, so the plain X_OK check below treats it as the
// CLI. That's a false positive whenever the real binary isn't installed: the
// launcher reports the agent as ready, hides its Install button, and launching
// it prints the shim's "not found in PATH" instead of starting anything.
//
// Skipping the shim is right in *both* directions, which is what makes this
// safe rather than a special case. If the real CLI exists further along PATH we
// find it, and running it directly is what the shim would have done anyway; if
// it doesn't, we correctly report the agent as missing and offer the install.
//
// Recognised by content rather than by directory: the marker travels with the
// file, so a wrapper dir that moves or gets renamed is still caught, and a real
// CLI that happens to live in one of those dirs is not.
const WRAPPER_MARKERS = [/superset[- ]agent[- ]wrapper/i];
const WRAPPER_PROBE_BYTES = 512;

function isWrapperShim(candidate) {
  let fd;
  try {
    fd = fs.openSync(candidate, 'r');
    const buf = Buffer.alloc(WRAPPER_PROBE_BYTES);
    const read = fs.readSync(fd, buf, 0, WRAPPER_PROBE_BYTES, 0);
    const head = buf.slice(0, read).toString('utf8');
    // Only a script can be one of these; a compiled binary never is, and
    // reading 512 bytes of one would just be noise to match against.
    if (!head.startsWith('#!')) return false;
    return WRAPPER_MARKERS.some((re) => re.test(head));
  } catch {
    // Unreadable is not the same as wrapped — leave the X_OK verdict alone.
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

// Resolve an executable against the snapshot PATH. Returns absolute path or null.
function resolveBin(cmd, env) {
  for (const dir of (env.PATH || '').split(':')) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (isWrapperShim(candidate)) continue;
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
  const env = deps.shellEnv();
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
        defaultCmd: a.defaultCmd,
        install: a.install,
        // Present only when a one-click install is available; the UI keys the
        // Install button off this and branches on `kind` for its wording.
        installer: a.installer ? { ...a.installer } : null,
        promptFlag: a.promptFlag || null,
        sessionRegistry: !!a.sessionRegistry,
        resumeFlag: a.resumeFlag || null,
        models: a.models ? a.models.map((m) => ({ ...m })) : null,
        chat: a.chat || null,
        // How this Agent's TUI takes a question-card answer; no key map, no cards.
        ask: a.ask?.kind || null,
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
      installer: null,
      promptFlag: null,
      isCustom: false,
      enabled: true,
      detected: true,
      path: getUserShell(),
    },
  ];
}

// ── One-click install ────────────────────────────────────────────────────────
// Two mechanisms, and the ordering between them is deliberate. Homebrew is
// preferred wherever a package exists: undoable, auditable, already the app's
// dependency channel. npm-global hints stay text-only — `npm install -g` needs
// a node version WPXen doesn't manage, writes outside the Homebrew prefix, and
// has no clean undo.
//
// A vendor script is the fallback for CLIs distributed no other way. It runs
// code fetched from the network, which is a real step up in trust from `brew
// install`, so it is opt-in per registry entry, https-only, and the button
// states what it will do rather than presenting it as the same act.
//
// brew.cjs is required lazily so this module stays importable outside Electron
// (brew.cjs itself is safe, but the seam below is what tests swap).
const deps = {
  store: null,
  now: () => Date.now(),
  runBrewStreaming: (args, onProgress) =>
    require('./brew.cjs').runBrewStreaming(args, onProgress),
  isBrewInstalled: () => require('./brew.cjs').isBrewInstalled(),
  runScriptStreaming: (url, onProgress) => runVendorScript(url, onProgress),
  runNpmStreaming: (args, onProgress) => runNpmInstall(args, onProgress),
  // The pty layer, so tests can launch Sessions without a real shell.
  // Default delegates to the in-app terminal provider's node-pty spawn.
  spawnPty: null,
  terminalProvider: null,
  connectHost: null,
  userDataDir: () => os.tmpdir(),
  appVersion: () => '0.0.0',
  shellEnv: () => resolveShellEnv(),
  userShell: () => getUserShell(),
  homedir: () => os.homedir(),
  // Claude Code's per-process registry (see claudeRegistry.cjs): the process
  // table, and the sessionId one pid registered.
  listProcesses: () => require('./claudeRegistry.cjs').listProcesses(),
  readClaudeSessionId: (pid) => require('./claudeRegistry.cjs').readSessionId(pid),
  // The bin dir of a Site's PHP version, or null. php.cjs required lazily
  // like brew.cjs above.
  sitePhpBin: (site) => {
    const keg = site?.phpVersion && require('./php.cjs').phpKegDir(site.phpVersion);
    return keg ? `${keg}/bin` : null;
  },
};

// Default in-app terminal provider, delegating to deps.spawnPty when a test
// swaps it. When deps.terminalProvider is set, the engine uses that provider
// instead; wireProvider() subscribes the engine's output/exit handlers once per
// provider instance.
const inAppProvider = createInAppTerminalProvider({
  spawnPty: (file, args, opts) =>
    deps.spawnPty ? deps.spawnPty(file, args, opts) : defaultSpawnPty(file, args, opts),
});
const wiredProviders = new WeakSet();

// ── Session Host state (#231) ────────────────────────────────────────────────
let keepRunningOnQuit = false;
let hostClient = null;
let hostHello = null;
let hostConnectPromise = null;
let detachingForQuit = false;
let hostStatus = { fallback: false, message: null, error: null };
const hostStatusListeners = new Set();

function getHostStatus() {
  return { ...hostStatus };
}

function onHostStatusChanged(cb) {
  hostStatusListeners.add(cb);
  return () => hostStatusListeners.delete(cb);
}

function setHostStatus(next) {
  hostStatus = {
    fallback: !!next?.fallback,
    message: next?.message || null,
    error: next?.error || null,
  };
  const snap = getHostStatus();
  for (const cb of hostStatusListeners) {
    try {
      cb(snap);
    } catch {}
  }
}

function activateHostFallback(err) {
  setHostStatus({
    fallback: true,
    message:
      'Background session host could not start — sessions won’t survive quitting WPXen.',
    error: err?.message || String(err || 'unknown error'),
  });
}

function wireProvider(provider) {
  if (!provider || wiredProviders.has(provider)) return provider;
  wiredProviders.add(provider);
  provider.onOutput?.(({ sessionId, data }) => handleProviderOutput(sessionId, data));
  provider.onExit?.(({ sessionId, exitCode }) => handleProviderExit(sessionId, exitCode));
  provider.onStatus?.((ev) => handleProviderStatus(ev));
  provider.onDisconnect?.(() => handleHostDisconnect(provider));
  return provider;
}

function handleProviderStatus({ sessionId, state, title, changedAt, unread } = {}) {
  const session = sessions.get(sessionId);
  if (!session || session.exited) return;
  const prev = session.tracker.snapshot();
  const nextState = state || prev.state;
  const nextTitle = typeof title === 'string' ? title : prev.title;
  const nextChangedAt = changedAt ?? prev.changedAt;
  const nextUnread = typeof unread === 'boolean' ? unread : prev.unread;
  if (
    prev.state === nextState &&
    prev.title === nextTitle &&
    prev.changedAt === nextChangedAt &&
    prev.unread === nextUnread
  ) {
    return;
  }
  session.tracker = createTracker({
    now: deps.now,
    agent: session.agentId !== SHELL_ID,
    initial: {
      state: nextState,
      title: nextTitle,
      changedAt: nextChangedAt,
      unread: nextUnread,
    },
  });
  if (isOnScreen(sessionId)) {
    session.tracker.view(true);
    if (nextUnread) {
      session.provider?.markRead?.(sessionId, true)?.catch?.(() => {});
    }
  }
  if (nextTitle !== prev.title) saveSessionRecord(session);
  emitChange({
    immediate: nextState !== prev.state || nextUnread !== prev.unread,
  });
}

function handleHostDisconnect(disconnectedClient) {
  if (detachingForQuit) return;
  if (hostClient === disconnectedClient) {
    hostClient = null;
    hostHello = null;
    hostConnectPromise = null;
  }
  for (const s of [...sessions.values()]) {
    if (!s.exited && s.isHostSession) {
      handleProviderExit(s.sessionId, 1);
    }
  }
}

async function ensureHostClient() {
  if (hostClient) return hostClient;
  if (hostConnectPromise) return hostConnectPromise;
  hostConnectPromise = (async () => {
    try {
      const connector =
        deps.connectHost ||
        (() =>
          require('./sessionHostManager.cjs').connectOrStartHost({
            userDataDir: deps.userDataDir(),
            version: deps.appVersion(),
          }));
      const res = await connector();
      const client = res?.client || res;
      wireProvider(client);
      hostClient = client;
      hostHello = res?.hello || null;
      setHostStatus({ fallback: false, message: null, error: null });
      return client;
    } catch (err) {
      hostClient = null;
      hostHello = null;
      activateHostFallback(err);
      throw err;
    } finally {
      hostConnectPromise = null;
    }
  })();
  return hostConnectPromise;
}

const hostProviderProxy = {
  isHostProvider: true,
  start: (opts) =>
    hostClient ? hostClient.start(opts) : ensureHostClient().then((c) => c.start(opts)),
  write: (sessionId, data) =>
    hostClient
      ? hostClient.write(sessionId, data)
      : ensureHostClient().then((c) => c.write(sessionId, data)),
  resize: (sessionId, cols, rows) =>
    hostClient
      ? hostClient.resize(sessionId, cols, rows)
      : ensureHostClient().then((c) => c.resize(sessionId, cols, rows)),
  stop: (sessionId) =>
    hostClient
      ? hostClient.stop(sessionId)
      : ensureHostClient().then((c) => c.stop(sessionId)),
  attach: (sessionId) =>
    hostClient
      ? hostClient.attach(sessionId)
      : ensureHostClient().then((c) => c.attach(sessionId)),
  clearBuffer: (sessionId) =>
    hostClient
      ? hostClient.clearBuffer(sessionId)
      : ensureHostClient().then((c) => c.clearBuffer(sessionId)),
  markRead: (sessionId, read = true) =>
    hostClient
      ? hostClient.markRead(sessionId, read)
      : ensureHostClient().then((c) => c.markRead(sessionId, read)),
  getPid: (sessionId) => hostClient?.getPid?.(sessionId) ?? null,
};

function activeProvider(scope = 'site') {
  if (deps.terminalProvider) {
    return wireProvider(deps.terminalProvider);
  }
  if (keepRunningOnQuit && !hostStatus.fallback && scope === 'site') {
    return hostProviderProxy;
  }
  return wireProvider(inAppProvider);
}

async function setKeepRunningOnQuit(enabled, { deferConnect = false } = {}) {
  keepRunningOnQuit = Boolean(enabled);
  if (!keepRunningOnQuit) {
    setHostStatus({ fallback: false, message: null, error: null });
    if (hostClient) {
      const hasLiveHostSession = [...sessions.values()].some(
        (s) => !s.exited && s.isHostSession
      );
      if (!hasLiveHostSession) {
        const client = hostClient;
        hostClient = null;
        hostHello = null;
        hostConnectPromise = null;
        await client.close().catch(() => {});
      }
    }
    return;
  }
  if (deferConnect) return;
  try {
    await ensureHostClient();
  } catch {
    // Fallback status already recorded by ensureHostClient.
  }
}

function getKeepRunningOnQuit() {
  return keepRunningOnQuit;
}

async function initSessionHost() {
  if (!keepRunningOnQuit) return listAllSessions();
  let client;
  try {
    client = await ensureHostClient();
  } catch {
    return listAllSessions();
  }
  let hostSessions = [];
  try {
    hostSessions = (await client.list()) || [];
  } catch {
    return listAllSessions();
  }

  let changed = false;
  for (const hs of hostSessions) {
    const session = sessions.get(hs.sessionId);
    if (!session) continue;
    if (!hs.exited) {
      session.exited = false;
      session.endedAt = null;
      session.exitCode = null;
      session.provider = hostProviderProxy;
      session.isHostSession = true;
      session.hostVersion = hostHello?.appVersion || deps.appVersion();
      session.pty = makePtyHandle(hostProviderProxy, session.sessionId);
      session.started = true;
      session.scheduleRun = null;
      const prevTitle = session.tracker.snapshot().title;
      session.tracker = createTracker({
        now: deps.now,
        agent: session.agentId !== SHELL_ID,
        initial: {
          state: hs.state || 'idle',
          title: hs.title || prevTitle || '',
          changedAt: hs.changedAt || session.startedAt,
          unread: !!hs.unread,
        },
      });
      try {
        const snap = await client.attach(session.sessionId);
        if (typeof snap?.data === 'string') session.buffer = snap.data;
      } catch {}
      if (session.resumeFlag) startRegistryPin(session);
      saveSessionRecord(session);
      changed = true;
    } else if (hs.exitCode != null && session.exitCode !== hs.exitCode) {
      session.exitCode = hs.exitCode;
      saveSessionRecord(session);
      changed = true;
    }
  }
  if (changed) emitChange({ immediate: true });
  return listAllSessions();
}

function bindStore(store) {
  deps.store = store;
}

function __setDeps(next) {
  Object.assign(deps, next);
  if (next.setInterval || next.statSync) {
    require('./agentChat.cjs').__setDeps(next);
  }
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

// Validates a script installer's URL. https only, no embedded credentials —
// this is the one place WPXen runs code it did not ship, so the transport has
// to be authenticated or the exercise is theatre.
function installScriptUrl(target) {
  if (!target || typeof target.url !== 'string' || !target.url.trim()) {
    throw new Error('No install script for this agent');
  }
  let parsed;
  try {
    parsed = new URL(target.url);
  } catch {
    throw new Error(`Invalid install script URL: ${target.url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Install scripts must be served over https: ${target.url}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Install script URL must not carry credentials');
  }
  return parsed.toString();
}

// Builds the npm argv for a global install. Pure, like brewInstallArgs, and
// guarded the same way: the spec lands in an argv, so anything that isn't a
// plain package name (optionally scoped, optionally with a @version or tag)
// is refused rather than trusted to be harmless.
function npmInstallArgs(target) {
  if (!target || typeof target.package !== 'string' || !target.package.trim()) {
    throw new Error('No npm package for this agent');
  }
  const spec = target.package.trim();
  if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~*-]+)?$/i.test(spec)) {
    throw new Error(`Invalid npm package spec: ${spec}`);
  }
  return ['install', '-g', spec];
}

// Runs `npm install -g …` under the user's login-shell environment, so it uses
// whatever node they actually have (nvm, Homebrew, Volta) rather than whatever
// Electron was launched with.
//
// Known limitation, surfaced in the UI rather than hidden: a global install
// lands in the *active* node version's prefix. Switch node and the CLI is gone
// from PATH, and WPXen has no way to undo the install the way `brew uninstall`
// would. That is why brew is still preferred wherever a package exists.
function runNpmInstall(args, onProgress) {
  const { spawn } = require('child_process');
  const env = resolveShellEnv();

  if (!resolveBin('npm', env)) {
    return Promise.reject(new Error('npm was not found on your PATH'));
  }

  return new Promise((resolve, reject) => {
    let tail = '';
    const child = spawn('npm', args, { env });
    const emit = (buf) => {
      const text = buf.toString();
      tail = (tail + text).slice(-4000);
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && typeof onProgress === 'function') onProgress(trimmed);
      }
    };
    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      // npm puts the useful line behind `npm error`/`npm ERR!` noise; prefer it
      // over the raw tail, the way runBrewStreaming prefers brew's `Error:`.
      const match = tail.match(/^npm (?:error|ERR!)\s+(.+)$/m);
      reject(new Error(match ? match[1].trim() : tail.trim() || `npm exited ${code}`));
    });
  });
}

// A shell script, not an HTML error page a CDN served with a 200, and not an
// empty body from a truncated transfer. Split out from the runner so the guard
// is testable without touching the network.
function assertShellScript(body) {
  if (!body || !body.trim()) {
    throw new Error('Downloaded installer is empty — refusing to run it');
  }
  if (!body.trim().startsWith('#!')) {
    throw new Error('Downloaded installer is not a shell script — refusing to run it');
  }
  return true;
}

// Fetches a vendor install script and runs it, streaming output line by line.
//
// Deliberately NOT `curl … | bash` through a shell: both halves are spawned
// with argv arrays, so nothing in the URL can become shell syntax. Downloading
// first also means a truncated response or an error page a CDN served with a
// 200 fails the shape check below instead of being executed halfway.
function runVendorScript(url, onProgress) {
  const { spawn } = require('child_process');
  const script = path.join(
    os.tmpdir(),
    `wpxen-agent-install-${Date.now()}-${process.pid}.sh`
  );

  const tail = { value: '' };
  const stream = (child) =>
    new Promise((resolve, reject) => {
      const emit = (buf) => {
        const text = buf.toString();
        tail.value = (tail.value + text).slice(-4000);
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed && typeof onProgress === 'function') onProgress(trimmed);
        }
      };
      child.stdout?.on('data', emit);
      child.stderr?.on('data', emit);
      child.on('error', reject);
      child.on('close', resolve);
    });

  return (async () => {
    try {
      const fetched = await stream(
        spawn('curl', [
          '-fsSL',
          '--proto',
          '=https',
          '--max-time',
          '120',
          '-o',
          script,
          url,
        ])
      );
      if (fetched !== 0) {
        throw new Error(`Could not download the install script (curl exit ${fetched})`);
      }

      assertShellScript(fs.readFileSync(script, 'utf8'));

      const ran = await stream(spawn('bash', [script], { env: resolveShellEnv() }));
      if (ran !== 0) {
        throw new Error(tail.value.trim() || `Install script failed (exit ${ran})`);
      }
    } finally {
      try {
        fs.unlinkSync(script);
      } catch {}
    }
  })();
}

// Installs an Agent's CLI, streaming the installer's output line by line.
// Resolves once it exits 0; the caller re-runs listAgents to pick up the new
// binary (detection is a live PATH probe, so nothing needs invalidating).
async function installAgent(id, onProgress) {
  const agent = effectiveRegistry().find((a) => a.id === id);
  if (!agent) throw new Error(`Unknown agent: ${id}`);
  if (!agent.installer) {
    throw new Error(
      `${agent.name} has no one-click install — install it with: ${agent.install}`
    );
  }

  if (agent.installer.kind === 'brew') {
    if (!deps.isBrewInstalled()) throw new Error('Homebrew is not installed');
    await deps.runBrewStreaming(brewInstallArgs(agent.installer), onProgress);
    return;
  }

  if (agent.installer.kind === 'npm') {
    await deps.runNpmStreaming(npmInstallArgs(agent.installer), onProgress);
    return;
  }

  if (agent.installer.kind === 'script') {
    await deps.runScriptStreaming(installScriptUrl(agent.installer), onProgress);
    return;
  }

  throw new Error(`Unknown installer kind: ${agent.installer.kind}`);
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
// POSIX single-quoting: everything literal, `'` as '\''.
function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

// The issue a Session works on, trimmed to what the list and sidebar show.
function cleanIssueLink(issue) {
  return {
    repo: String(issue.repo || ''),
    number: Number(issue.number) || null,
    url: String(issue.url || ''),
    title: String(issue.title || '').slice(0, 300),
    kind: issue.kind === 'pr' ? 'pr' : 'issue',
  };
}

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
//
// Each non-floating Session's record is persisted in the store under
// SESSIONS_STORE_KEY as it changes (launch, title/transcriptId change, exit).
// On the next launch restoreSessions() reloads them as ended, capped at
// MAX_ENDED_SESSIONS_PER_PROJECT per Project with the oldest dropped first.
const { randomUUID } = require('crypto');
const MAX_BUFFER = 1024 * 1024; // ~1 MB ring buffer (Q9)
const SESSIONS_STORE_KEY = 'agentSessions';
const MAX_ENDED_SESSIONS_PER_PROJECT = 50;
const sessions = new Map(); // sessionId -> session
const layouts = new Map(); // rootId -> layout tree

// Serialise a live or restored Session into its persisted store record.
function toSessionRecord(s) {
  const snap = s.tracker.snapshot();
  const exitState =
    snap.state === 'error' || (s.exited && s.exitCode != null && s.exitCode !== 0)
      ? 'error'
      : 'exited';
  return {
    sessionId: s.sessionId,
    siteId: s.siteId,
    agentId: s.agentId,
    agentName: s.agentName,
    targetId: s.targetId || null,
    label: s.label || null,
    customTitle: s.customTitle || null,
    pinned: !!s.pinned,
    color: s.color || null,
    cwd: s.cwd || null,
    title: snap.title || '',
    transcriptId: s.transcriptId || null,
    handoffFrom: s.handoffFrom || null,
    handoffFile: s.handoffFile || null,
    resumeFrom: s.resumeFrom || null,
    issue: s.issue || null,
    startedAt: s.startedAt,
    endedAt: s.endedAt || null,
    exitCode: s.exitCode ?? null,
    exitState: s.exited ? exitState : null,
    hostVersion: s.hostVersion || null,
  };
}

// Keep all live Sessions plus at most MAX_ENDED_SESSIONS_PER_PROJECT ended
// records per Project (oldest dropped first, by startedAt).
function capEndedRecords(records, isLive = () => false) {
  const byProject = new Map();
  for (const r of records) {
    if (!r || !r.sessionId || !r.siteId) continue;
    if (isLive(r.sessionId)) continue;
    if (!byProject.has(r.siteId)) byProject.set(r.siteId, []);
    byProject.get(r.siteId).push(r);
  }
  const dropped = new Set();
  for (const list of byProject.values()) {
    if (list.length <= MAX_ENDED_SESSIONS_PER_PROJECT) continue;
    const sorted = [...list].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    const excess = sorted.length - MAX_ENDED_SESSIONS_PER_PROJECT;
    for (let i = 0; i < excess; i++) dropped.add(sorted[i].sessionId);
  }
  return dropped.size ? records.filter((r) => !dropped.has(r.sessionId)) : records;
}

function saveSessionRecord(session) {
  if (!deps.store || session.scope === 'floating' || !session.siteId) return;
  const list = deps.store.get(SESSIONS_STORE_KEY, []);
  const rec = toSessionRecord(session);
  const idx = list.findIndex((r) => r?.sessionId === session.sessionId);
  const next = idx >= 0 ? list.map((r, i) => (i === idx ? rec : r)) : [...list, rec];
  const capped = capEndedRecords(next, (id) => {
    const s = sessions.get(id);
    return !!s && !s.exited;
  });
  for (const r of next) {
    if (r?.sessionId && !capped.includes(r)) {
      sessions.delete(r.sessionId);
      notifier.forget(r.sessionId);
      deleteHistory(historyDir(deps.userDataDir()), r.sessionId);
    }
  }
  deps.store.set(SESSIONS_STORE_KEY, capped);
}

function removeSessionRecord(sessionId) {
  if (!deps.store) return;
  const list = deps.store.get(SESSIONS_STORE_KEY, []);
  const next = list.filter((r) => r?.sessionId !== sessionId);
  if (next.length !== list.length) deps.store.set(SESSIONS_STORE_KEY, next);
}

// Restore persisted Sessions from the store as ended. Records whose Project is
// not in `projectIds` (when provided) are dropped; ended records per Project
// are capped at 50 (oldest dropped first).
function restoreSessions({ projectIds = null } = {}) {
  for (const s of [...sessions.values()]) {
    if (s.scope === 'floating') continue;
    stopRegistryPin(s);
    sessions.delete(s.sessionId);
  }
  layouts.clear();
  if (!deps.store) {
    emitChange({ immediate: true });
    return [];
  }
  const knownProjects = projectIds ? new Set(projectIds) : null;
  const raw = deps.store.get(SESSIONS_STORE_KEY, []);
  const valid = (Array.isArray(raw) ? raw : []).filter(
    (r) =>
      r &&
      typeof r.sessionId === 'string' &&
      typeof r.siteId === 'string' &&
      (!knownProjects || knownProjects.has(r.siteId))
  );
  const kept = capEndedRecords(valid);
  const now = deps.now();
  const agentsById = new Map(listAgents({ all: true }).map((a) => [a.id, a]));

  const normalized = [];
  for (const r of kept) {
    const agent = agentsById.get(r.agentId);
    const endedAt = r.endedAt || r.startedAt || now;
    const exitState = r.exitState === 'error' ? 'error' : 'exited';
    const exitCode = r.exitCode ?? (exitState === 'error' ? 1 : 0);
    const tracker = createTracker({
      now: deps.now,
      agent: r.agentId !== SHELL_ID,
      initial: {
        state: exitState,
        title: r.title || '',
        changedAt: endedAt,
        unread: false,
      },
    });
    const session = {
      sessionId: r.sessionId,
      scope: 'site',
      siteId: r.siteId,
      agentId: r.agentId,
      agentName: agent?.name || r.agentName || r.agentId,
      targetId: r.targetId || null,
      label: r.label || null,
      customTitle: r.customTitle || null,
      pinned: !!r.pinned,
      color: r.color || null,
      cwd: r.cwd || null,
      paneOf: null,
      handoffFrom: r.handoffFrom || null,
      handoffFile: r.handoffFile || null,
      resumeFrom: r.resumeFrom || null,
      transcriptId: r.transcriptId || null,
      chat: agent?.chat || null,
      ask: agent?.ask || null,
      resumeFlag: agent?.resumeFlag || null,
      issue: r.issue || null,
      pty: null,
      buffer: '',
      window: null,
      exited: true,
      exitCode,
      startedAt: r.startedAt || endedAt,
      endedAt,
      lastOutputAt: endedAt,
      tracker,
      started: true,
    };
    sessions.set(session.sessionId, session);
    normalized.push(toSessionRecord(session));
  }
  deps.store.set(SESSIONS_STORE_KEY, normalized);
  pruneOrphanedHistory(
    historyDir(deps.userDataDir()),
    normalized.map((r) => r.sessionId)
  );
  emitChange({ immediate: true });
  return listAllSessions();
}

// Change feed for the Agents sidebar. Title updates arrive at spinner rate, so
// notifications are coalesced into one per CHANGE_DEBOUNCE_MS; launches, exits
// and stops are flushed immediately.
const CHANGE_DEBOUNCE_MS = 200;
const changeListeners = new Set();
const floatingListeners = new Set();
let changeTimer = null;

function onSessionsChanged(cb) {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

// The Floating Workspace's own feed — its terminals never reach the Site feed
// above, so everything keyed on that (Projects, keep-awake, tray) ignores them.
function onFloatingSessionsChanged(cb) {
  floatingListeners.add(cb);
  return () => floatingListeners.delete(cb);
}

function emitChange({ immediate = false } = {}) {
  if (changeTimer && !immediate) return;
  if (changeTimer) clearTimeout(changeTimer);
  const fire = () => {
    changeTimer = null;
    const feeds = [
      [changeListeners, listAllSessions],
      [floatingListeners, listFloatingSessions],
    ];
    for (const [listeners, list] of feeds) {
      if (listeners.size === 0) continue;
      const rows = list();
      for (const cb of listeners) {
        try {
          cb(rows);
        } catch {}
      }
    }
  };
  if (immediate) fire();
  else changeTimer = setTimeout(fire, CHANGE_DEBOUNCE_MS);
}

// Native alerts. The tracker reports what happened, the notifier decides what
// deserves a notification, and whoever registered with onAlert delivers it —
// ipc.cjs, with Electron's Notification — so this module stays electron-free.
const notifier = createNotifier();
const alertListeners = new Set();
let notifySettings = {
  enabled: true,
  onDone: true,
  onNeedsInput: true,
  onBell: true,
  suppressWhenFocused: true,
};

function setNotificationSettings(next) {
  notifySettings = { ...notifySettings, ...next };
}

function onAlert(cb) {
  alertListeners.add(cb);
  return () => alertListeners.delete(cb);
}

function deliverAlerts(session) {
  // Floating terminals are scratch shells: their status still lights the
  // launcher's dot, but they never raise a native notification.
  if (session.scope === 'floating') {
    session.tracker.drainEvents();
    return;
  }
  for (const kind of session.tracker.drainEvents()) {
    const ok = notifier.decide({
      sessionId: session.sessionId,
      kind,
      onScreen: isOnScreen(session.sessionId),
      settings: notifySettings,
    });
    if (!ok) continue;
    const snap = session.tracker.snapshot();
    const alert = {
      kind,
      sessionId: session.sessionId,
      siteId: session.siteId,
      agentId: session.agentId,
      agentName: session.agentName,
      title: snap.title || session.label || session.agentName,
    };
    for (const cb of alertListeners) {
      try {
        cb(alert);
      } catch {}
    }
  }
}

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

function getBuffer(sessionId) {
  const session = sessions.get(sessionId);
  return session ? session.buffer : null;
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

// Every Session across all Sites, live and exited, oldest first — the Agents
// sidebar's rows. An exited Session stays listed until it is dismissed (stop)
// or the app quits, so finishing or crashing while unwatched stays visible.
function listAllSessions() {
  const out = [];
  for (const s of sessions.values()) {
    if (s.scope === 'floating') continue;
    out.push(sessionRow(s));
  }
  return out;
}

// The Floating Workspace's terminals, live and exited, oldest first.
function listFloatingSessions() {
  const out = [];
  for (const s of sessions.values()) {
    if (s.scope === 'floating') out.push({ ...sessionRow(s), cwd: s.cwd });
  }
  return out;
}

function sessionRow(s) {
  const snap = s.tracker.snapshot();
  return {
    sessionId: s.sessionId,
    siteId: s.siteId,
    agentId: s.agentId,
    agentName: s.agentName,
    targetId: s.targetId,
    label: s.label,
    customTitle: s.customTitle || null,
    pinned: !!s.pinned,
    color: s.color || null,
    // The folder the Session runs in: what its tab and sidebar row are named.
    cwd: s.cwd || null,
    paneOf: s.paneOf || null,
    layout: !s.paneOf ? layouts.get(s.sessionId) || { leaf: s.sessionId } : null,
    handoffFrom: s.handoffFrom || null,
    handoffFile: s.handoffFile || null,
    resumeFrom: s.resumeFrom || null,
    transcriptId: s.transcriptId || null,
    chat: s.chat || null,
    ask: s.ask || null,
    resumeFlag: s.resumeFlag || null,
    // The issue or PR Start → launched this Session for, else null.
    issue: s.issue || null,
    startedAt: s.startedAt,
    endedAt: s.endedAt || null,
    exited: s.exited,
    exitCode: s.exitCode,
    title: snap.title,
    state: snap.state,
    changedAt: snap.changedAt,
    unread: snap.unread,
    // An AI-provider Session rather than the plain shell — keep-awake's
    // Agent mode counts only these.
    isAgent: s.agentId !== SHELL_ID,
    // Last pty output, for keep-awake's stale cutoff. Not itself a change
    // event: readers that need it fresh call listAllSessions() again.
    lastOutputAt: s.lastOutputAt,
  };
}

// Launch an Agent for a Site. Always creates a NEW Session so multiple can run
// per directory. `target` (a saved Launch Target) and `globalArgs` (the Agent's
// global default flags) are optional; both flow through `resolveLaunch` to
// decide the cwd and the command line typed into the shell.
//
// Tasks' Start → adds three: `cwd` (the repo root or a fresh worktree, in
// place of the webroot), `prompt` (passed to the agent as its first message,
// shell-quoted onto the command line) and `issue` ({ repo, number, url,
// title, kind }), which the Session carries so Tasks and the sidebar can link
// back to it.
// Returns { ok, sessionId } or { error }.
function launch({
  site,
  agentId,
  target = null,
  globalArgs = '',
  cwd: cwdOverride = null,
  prompt = '',
  issue = null,
  paneOf = null,
  handoffFrom = null,
  handoffFile = null,
  // Resume a pinned transcript in a new Session: the Agent keeps appending
  // to the same transcript file.
  resume = null,
  resumeFrom = null,
}) {
  // `all` so launching by id still works for an agent hidden from the
  // launcher (e.g. a saved session being restored).
  const agent = listAgents({ all: true }).find((a) => a.id === agentId);
  if (!agent) return { error: `Unknown agent: ${agentId}` };
  if (resume && !agent.resumeFlag)
    return { error: `${agent.name} does not support resuming a session` };
  // The shell is always present, so this only ever rejects a missing provider.
  if (!agent.detected) return { error: `${agent.name} is not installed` };

  const resolved = resolveLaunch({
    cmd: agent.cmd,
    sitePath: site.path,
    globalArgs,
    target,
  });
  const cwd = cwdOverride ? path.normalize(cwdOverride) : resolved.cwd;
  // The shell never runs with an agent command line it can't type: the
  // prompt is one line, single-quoted.
  const line = String(prompt || '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();

  // A fresh launch types no session id; the pin arrives from the registry.
  const transcriptId = resume || undefined;
  let typed = resolved.command;
  if (resume) typed += ` ${agent.resumeFlag} ${resume}`;
  if (line) {
    typed += ` ${agent.promptFlag ? agent.promptFlag + ' ' : ''}${shellQuote(line)}`;
  }

  // The Site's PHP first on PATH: a zsh wrapper for the whole shell (see
  // shellIntegration.cjs), or for other shells, on the agent's command line.
  const phpBinDir = deps.sitePhpBin(site);
  const command = shellIntegration.prefixCommandWithPhp(
    typed,
    deps.userShell(),
    phpBinDir
  );

  return startSession({
    cwd,
    command,
    phpBinDir,
    meta: {
      scope: 'site',
      siteId: site.id,
      agentId: agent.id,
      agentName: agent.name,
      targetId: target?.id || null,
      label: resolved.label,
      issue: issue ? cleanIssueLink(issue) : null,
      paneOf,
      handoffFrom,
      handoffFile,
      resumeFrom,
      transcriptId,
      pinFromRegistry: !!agent.sessionRegistry,
      chat: agent.chat || null,
      ask: agent.ask || null,
      resumeFlag: agent.resumeFlag || null,
    },
    failLabel: agent.name,
  });
}

// Resume a pinned transcript in a new Session beside the old one. The new
// Session carries the same transcriptId, so its chat view continues the same
// conversation. The exit bar only offers Resume once the old Session has
// ended; the same gate is enforced here, beside the transcript and the
// Agent's resumeFlag checks.
function resumeChatSession(sessionId, { site, target = null, globalArgs = '' } = {}) {
  const old = sessions.get(sessionId);
  if (!old) return { error: 'Session not found' };
  if (!old.transcriptId) return { error: 'No pinned transcript to resume' };
  // Two live Sessions must never drive one conversation: the old Agent has
  // to have exited (its shell may still be up) before a second one resumes.
  const oldState = old.tracker.snapshot().state;
  if (!old.exited && oldState !== 'exited' && oldState !== 'error')
    return { error: 'The Session is still running — resume once it has exited' };
  const agent = listAgents({ all: true }).find((a) => a.id === old.agentId);
  if (!agent) return { error: `Unknown agent: ${old.agentId}` };
  if (!agent.resumeFlag)
    return { error: `${agent.name} does not support resuming a session` };
  return launch({
    site,
    agentId: old.agentId,
    target,
    globalArgs,
    cwd: old.cwd,
    resume: old.transcriptId,
    resumeFrom: old.sessionId,
  });
}

// A Floating Workspace terminal: a plain shell in `cwd`, owned by no Site. It
// runs on the same pty engine (ring buffer, status tracking, reaped on quit)
// but stays out of everything that means "a Site's Sessions" — the Projects
// list, keep-awake, the tray count, notifications and the quit warning. A
// leading `~` is expanded here, since the renderer doesn't know the home dir.
//
// `command`, when given, is typed into the shell once it settles — the way an
// agent command is — so a flow like `gh auth login` runs in a real terminal
// the user can interact with. One line only; it's typed, not exec'd.
function launchFloating({ cwd, command = '' } = {}) {
  const line = String(command || '').trim();
  if (/[\r\n]/.test(line)) return { error: 'A floating command must be a single line' };
  const raw = String(cwd || '~').trim() || '~';
  const home = deps.homedir();
  const resolved =
    raw === '~' ? home : raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw;
  if (!path.isAbsolute(resolved)) return { error: `Directory not found: ${raw}` };
  return startSession({
    cwd: path.normalize(resolved),
    command: line,
    meta: {
      scope: 'floating',
      siteId: null,
      agentId: SHELL_ID,
      agentName: SHELL_AGENT.name,
      targetId: null,
      label: null,
    },
    failLabel: 'the shell',
  });
}

function makePtyHandle(provider, sessionId) {
  return {
    get pid() {
      return provider.getPid?.(sessionId) ?? null;
    },
    write: (data) => {
      const res = provider.write(sessionId, data);
      res?.catch?.(() => {});
    },
    resize: (cols, rows) => {
      const res = provider.resize(sessionId, cols, rows);
      res?.catch?.(() => {});
    },
    kill: () => {
      const res = provider.stop(sessionId);
      res?.catch?.(() => {});
    },
  };
}

// Spawn the pty for a resolved launch and register its Session. `meta` carries
// who owns it (a Site's agent, or the Floating Workspace); `command` is typed
// into the shell once it settles, or nothing for a plain shell.
function startSession({ cwd, command, meta, failLabel, phpBinDir = null }) {
  // A Target's directory can go stale (a deleted worktree, a moved plugin).
  // Fail loudly before spawning a shell in a bad cwd rather than dropping the
  // user into their home dir with no explanation.
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory');
  } catch {
    return { error: `Directory not found: ${cwd}` };
  }

  const sessionId = randomUUID();
  const env = stripParentAgentEnv(deps.shellEnv());
  let phpEnv = {};
  try {
    phpEnv = shellIntegration.sitePhpEnv({ env, shell: deps.userShell(), phpBinDir });
  } catch {
    // A terminal on the global PHP beats no terminal.
  }
  // Spawn the user's interactive login SHELL — not the agent binary directly —
  // and type the agent command into it. Exiting the agent CLI then drops back to
  // a normal shell prompt (like Superset), and the Session only ends when the
  // shell itself exits. `-il` sources the user's rc files.
  const shell = deps.userShell();
  let provider = activeProvider(meta.scope);
  const startOpts = {
    sessionId,
    file: shell,
    args: ['-il'],
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    agent: meta.agentId !== SHELL_ID,
    env: {
      ...env,
      ...phpEnv,
      TERM: 'xterm-256color',
      TERM_PROGRAM: 'WPXen',
      // xterm.js renders 24-bit color, but CLIs only use it when told so:
      // supports-color (chalk, Ink) reads COLORTERM, and without it settles on
      // 256 colors. Claude Code's near-black, faintly blue prompt background
      // then quantizes to palette navy (#00005f/#000087) — a loud blue bar
      // behind every prompt. An app launched from Finder has no COLORTERM to
      // inherit, so set it.
      COLORTERM: 'truecolor',
      // The terminal handles OSC 8 hyperlinks (sessionCache's linkHandler),
      // but supports-hyperlinks only trusts a known TERM_PROGRAM list, which
      // WPXen isn't on. This is its override, so CLIs print links as labels.
      FORCE_HYPERLINK: '1',
      // Suppress oh-my-zsh's auto-update check. It fires during rc sourcing and
      // blocks on an interactive `[Y/n]` prompt (a single-char `read`); the
      // settle-window that types the agent command can't reliably out-wait it,
      // so the first char gets eaten by the prompt and the rest runs as a bad
      // command. `DISABLE_AUTO_UPDATE=true` maps to omz `update_mode=disabled`,
      // so the prompt never appears. Only affects this agent shell.
      DISABLE_AUTO_UPDATE: 'true',
    },
  };
  let startResult;
  try {
    startResult = provider.start(startOpts);
  } catch (err) {
    if (provider.isHostProvider) {
      activateHostFallback(err);
      provider = wireProvider(inAppProvider);
      try {
        startResult = provider.start(startOpts);
      } catch (err2) {
        return { error: `Failed to launch ${failLabel}: ${err2.message}` };
      }
    } else {
      return { error: `Failed to launch ${failLabel}: ${err.message}` };
    }
  }

  // A plain shell has nothing to type — the pty is already what was asked for.
  const startsImmediately = !command;

  const now = deps.now();
  const isHostSession = !!provider.isHostProvider;
  const session = {
    sessionId,
    ...meta,
    cwd,
    provider,
    isHostSession,
    hostVersion: isHostSession ? hostHello?.appVersion || deps.appVersion() : null,
    pty: makePtyHandle(provider, sessionId),
    buffer: '',
    window: null,
    exited: false,
    exitCode: null,
    startedAt: now,
    endedAt: null,
    lastOutputAt: now,
    tracker: createTracker({ now: deps.now, agent: meta.agentId !== SHELL_ID }),
    // `started` gates the type-the-command step; a shell session has already
    // arrived at what the user wanted, so it starts out done.
    started: startsImmediately,
    scheduleRun: null,
  };
  sessions.set(sessionId, session);
  session.tracker.view(isOnScreen(sessionId));
  saveSessionRecord(session);

  if (startResult && typeof startResult.catch === 'function') {
    startResult.catch((err) => {
      const s = sessions.get(sessionId);
      if (!s || s.exited) return;
      activateHostFallback(err);
      try {
        const fallback = wireProvider(inAppProvider);
        fallback.start(startOpts);
        s.provider = fallback;
        s.isHostSession = false;
        s.hostVersion = null;
        s.pty = makePtyHandle(fallback, sessionId);
        saveSessionRecord(s);
      } catch {
        handleProviderExit(sessionId, 1);
      }
    });
  }

  // Run the agent once the shell is ready: wait a short settle window after the
  // first output (so rc files that print during init don't swallow the typed
  // command), with an absolute fallback if the shell prints nothing first.
  let settleTimer = null;
  const runAgent = () => {
    if (session.started || session.exited) return;
    session.started = true;
    const res = session.provider.write(sessionId, `${command}\r`);
    res?.catch?.(() => {});
  };
  session.scheduleRun = () => {
    if (session.started || settleTimer) return;
    settleTimer = setTimeout(runAgent, 150);
  };
  if (!startsImmediately) setTimeout(runAgent, 1200); // fallback: no output first

  if (meta.pinFromRegistry) startRegistryPin(session);

  emitChange({ immediate: true });
  return { ok: true, sessionId };
}

function handleProviderOutput(sessionId, data) {
  const session = sessions.get(sessionId);
  if (!session || session.exited) return;
  session.lastOutputAt = deps.now();
  session.scheduleRun?.();
  const beforeSnap = session.tracker.snapshot();
  if (session.tracker.output(data)) {
    // Status and unread flips go out at once; title-only churn (spinner
    // frames) waits.
    const after = session.tracker.snapshot();
    if (after.title !== beforeSnap.title) saveSessionRecord(session);
    emitChange({
      immediate: after.state !== beforeSnap.state || after.unread !== beforeSnap.unread,
    });
  }
  deliverAlerts(session);
  session.buffer += data;
  if (session.buffer.length > MAX_BUFFER) {
    session.buffer = session.buffer.slice(session.buffer.length - MAX_BUFFER);
  }
  const win = session.window;
  if (win && !win.isDestroyed()) {
    win.webContents.send('terminal-data', { sessionId, data });
  }
}

function handleProviderExit(sessionId, exitCode) {
  const session = sessions.get(sessionId);
  if (!session || session.exited) return;
  session.exited = true;
  session.endedAt = deps.now();
  stopRegistryPin(session);
  session.exitCode = exitCode;
  session.tracker.exit(exitCode);
  deliverAlerts(session);
  const win = session.window;
  if (win && !win.isDestroyed()) {
    win.webContents.send('terminal-exit', { sessionId, code: exitCode });
  }
  // stop() already deleted a dismissed session; don't resurrect its row.
  if (sessions.has(sessionId)) {
    saveSessionRecord(session);
    emitChange({ immediate: true });
  }
}

// Learn which Claude conversation the Session is running from Claude's own
// registry: find the Claude process under this pty, then keep re-reading its
// entry so a /clear moves the pin with it. Until the first id arrives the
// Session is `transcriptPending`, and the chat view waits rather than guessing
// a sibling's transcript by recency. Once found, a tick is one small file
// read; the process table is only walked again when that pid's entry goes
// (Claude exited, maybe to be started again in the same shell). The last id
// is kept after Claude exits, so Resume still has it.
const REGISTRY_PIN_MS = 1500;

function startRegistryPin(session) {
  if (session.transcriptId == null) session.transcriptPending = true;
  let busy = false;
  const tick = async () => {
    if (busy || session.exited || !sessions.has(session.sessionId)) return;
    busy = true;
    try {
      let id = session.claudePid ? deps.readClaudeSessionId(session.claudePid) : null;
      if (!id) {
        session.claudePid = null;
        const rootPid = session.pty?.pid;
        if (!rootPid) return;
        const table = await deps.listProcesses();
        const { descendantPids } = require('./claudeRegistry.cjs');
        for (const pid of descendantPids(rootPid, table)) {
          id = deps.readClaudeSessionId(pid);
          if (id) {
            session.claudePid = pid;
            break;
          }
        }
      }
      if (id && id !== session.transcriptId) {
        session.transcriptId = id;
        session.transcriptPending = false;
        saveSessionRecord(session);
        emitChange({ immediate: true });
      }
    } catch {
      // try again next tick
    } finally {
      busy = false;
    }
  };
  session.pinTimer = setInterval(tick, REGISTRY_PIN_MS);
}

function stopRegistryPin(session) {
  if (session.pinTimer) clearInterval(session.pinTimer);
  session.pinTimer = null;
}

// Bind a Terminal Window to its Session and replay the ring buffer (Q9). Setting
// the window ref and sending replay happen synchronously, so no onData chunk can
// interleave between them — live chunks that follow arrive after the replay.
function attach(sessionId, win) {
  const session = sessions.get(sessionId);
  if (!session) return { error: 'no session' };
  session.window = win;
  const attached = session.provider?.attach?.(sessionId);
  const diskReplay = () =>
    session.buffer || readHistory(historyDir(deps.userDataDir()), sessionId);
  const sendReplay = (data, exited) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal-replay', {
        sessionId,
        data,
        exited,
      });
    }
  };
  if (attached && typeof attached.then === 'function') {
    attached
      .then((snap) => {
        if (typeof snap?.data === 'string') session.buffer = snap.data;
        sendReplay(snap?.data ?? diskReplay(), snap?.exited ?? session.exited);
      })
      .catch(() => sendReplay(diskReplay(), session.exited));
  } else {
    sendReplay(attached?.data ?? diskReplay(), attached?.exited ?? session.exited);
  }
  return { ok: true };
}

function write(sessionId, data) {
  const session = sessions.get(sessionId);
  if (session && !session.exited) {
    const res = (session.provider || activeProvider(session.scope)).write(
      sessionId,
      data
    );
    res?.catch?.(() => {});
    // xterm's own replies (device/cursor reports, focus events) share this
    // path with keystrokes but aren't the user answering anything.
    if (!isTerminalReply(data) && session.tracker.typed()) {
      emitChange({ immediate: true });
    }
  }
}

// What's on screen: the Session selected in the Agents pane (null when the
// pane isn't showing), the Floating Workspace's active terminal (null while
// the panel is minimised) and whether the window has focus. A Session counts
// as viewed only when the window is focused — selected in a background window
// isn't seen.
const view = { selected: null, floating: null, focused: false };

function isOnScreen(sessionId) {
  return view.focused && (view.selected === sessionId || view.floating === sessionId);
}

function setView(patch) {
  Object.assign(view, patch);
  let changed = false;
  for (const s of sessions.values()) {
    const onScreen = isOnScreen(s.sessionId);
    const wasUnread = s.tracker.snapshot().unread;
    if (s.tracker.view(onScreen)) {
      changed = true;
      if (onScreen && wasUnread && s.isHostSession) {
        s.provider?.markRead?.(s.sessionId, true)?.catch?.(() => {});
      }
    }
  }
  if (changed) emitChange({ immediate: true });
}

function markRead(sessionId, read = true) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const changed = read ? session.tracker.markRead() : session.tracker.markUnread();
  if (session.isHostSession) {
    session.provider?.markRead?.(sessionId, !!read)?.catch?.(() => {});
  }
  if (changed) emitChange({ immediate: true });
}

// Clear a Session's ring buffer so a later reattach doesn't replay content the
// user cleared with Cmd+K. No-op if the session is gone.
function clearBuffer(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    session.buffer = '';
    const res = session.provider?.clearBuffer?.(sessionId);
    res?.catch?.(() => {});
  }
}

function resize(sessionId, cols, rows) {
  const session = sessions.get(sessionId);
  if (session && !session.exited && cols > 0 && rows > 0) {
    const res = (session.provider || activeProvider(session.scope)).resize(
      sessionId,
      cols,
      rows
    );
    res?.catch?.(() => {});
  }
}

function splitPane(sessionId, dir, site, globalArgs = '') {
  const session = sessions.get(sessionId);
  if (!session) return { error: 'no session' };

  const rootId = session.paneOf || sessionId;
  let tree = layouts.get(rootId) || { leaf: rootId };

  const res = launch({
    site,
    agentId: SHELL_ID,
    cwd: session.cwd,
    globalArgs,
    paneOf: rootId,
  });

  if (!res.ok) return res;

  function insert(node) {
    if (node.leaf === sessionId) {
      return {
        dir,
        ratio: 50,
        a: { leaf: sessionId },
        b: { leaf: res.sessionId },
      };
    }
    if (node.dir) {
      return {
        ...node,
        a: insert(node.a),
        b: insert(node.b),
      };
    }
    return node;
  }

  layouts.set(rootId, insert(tree));
  emitChange({ immediate: true });
  return { ok: true, sessionId: res.sessionId };
}

// The name the user gave a Session (tab menu → Rename), or '' to go back to
// the automatic one. Ranked first by the renderer's sessionTitle. Lives with
// the Session in memory, like its layout: it ends when the Session does.
const MAX_CUSTOM_TITLE = 120;
function renameSession(sessionId, title) {
  const session = sessions.get(sessionId);
  if (!session) return { error: 'session not found' };
  const clean =
    typeof title === 'string'
      ? title.replace(/\s+/g, ' ').trim().slice(0, MAX_CUSTOM_TITLE)
      : '';
  if ((session.customTitle || '') === clean) return { ok: true };
  session.customTitle = clean || null;
  saveSessionRecord(session);
  emitChange({ immediate: true });
  return { ok: true };
}

// Pin a Session to the top of its project in the Agents sidebar (row menu →
// Pin, after Orca's Pin).
function setSessionPinned(sessionId, pinned) {
  const session = sessions.get(sessionId);
  if (!session) return { error: 'session not found' };
  if (!!session.pinned === !!pinned) return { ok: true };
  session.pinned = !!pinned;
  saveSessionRecord(session);
  emitChange({ immediate: true });
  return { ok: true };
}

// The tab colors a Session can carry (tab menu → Tab Color). Mirrors
// TAB_COLORS in src/lib/tabColors.js; anything else is refused.
const TAB_COLOR_VALUES = [
  '#3b82f6',
  '#a855f7',
  '#ec4899',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#9ca3af',
];

// Mark a Session's tab (and sidebar row) with a color, or null for none.
function setSessionColor(sessionId, color) {
  const session = sessions.get(sessionId);
  if (!session) return { error: 'session not found' };
  const next = color == null ? null : String(color).toLowerCase();
  if (next !== null && !TAB_COLOR_VALUES.includes(next))
    return { error: 'unknown tab color' };
  if ((session.color || null) === next) return { ok: true };
  session.color = next;
  saveSessionRecord(session);
  emitChange({ immediate: true });
  return { ok: true };
}

function setPaneRatio(rootId, path, ratio) {
  let tree = layouts.get(rootId);
  if (!tree) return;

  function update(node, currentPath) {
    if (!node.dir) return node;
    if (currentPath === path) {
      return { ...node, ratio };
    }
    return {
      ...node,
      a: update(node.a, currentPath + 'a'),
      b: update(node.b, currentPath + 'b'),
    };
  }

  layouts.set(rootId, update(tree, ''));
  emitChange({ immediate: true });
}

function removeLeaf(node, leafId) {
  if (node.leaf === leafId) return null;
  if (node.dir) {
    const a = removeLeaf(node.a, leafId);
    const b = removeLeaf(node.b, leafId);
    if (!a && !b) return null;
    if (!a) return b;
    if (!b) return a;
    return { ...node, a, b };
  }
  return node;
}

function firstLeaf(node) {
  if (node.leaf) return node.leaf;
  return firstLeaf(node.a);
}

function rewritePaneOf(node, rootId) {
  if (node.leaf) {
    const s = sessions.get(node.leaf);
    if (s) s.paneOf = node.leaf === rootId ? null : rootId;
  } else if (node.dir) {
    rewritePaneOf(node.a, rootId);
    rewritePaneOf(node.b, rootId);
  }
}

function closePane(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const rootId = session.paneOf || sessionId;
  const tree = layouts.get(rootId);
  if (tree) {
    const newTree = removeLeaf(tree, sessionId);
    if (!newTree) {
      layouts.delete(rootId);
    } else if (!newTree.dir) {
      layouts.delete(rootId);
      const remainingId = newTree.leaf;
      if (remainingId !== rootId) {
        rewritePaneOf(newTree, remainingId);
      }
    } else if (rootId === sessionId) {
      const newRootId = firstLeaf(newTree);
      layouts.delete(rootId);
      layouts.set(newRootId, newTree);
      rewritePaneOf(newTree, newRootId);
    } else {
      layouts.set(rootId, newTree);
    }
  }
}

function leaves(node) {
  if (node.leaf) return [node.leaf];
  return [...leaves(node.a), ...leaves(node.b)];
}

function replaceLeaf(node, oldId, newId) {
  if (node.leaf) return node.leaf === oldId ? { leaf: newId } : node;
  return {
    ...node,
    a: replaceLeaf(node.a, oldId, newId),
    b: replaceLeaf(node.b, oldId, newId),
  };
}

// Closing a tab ends every pane in it. Dropping the layout first keeps stop()
// from promoting a pane into a tab that is going away anyway.
function stopTab(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const rootId = session.paneOf || sessionId;
  const tree = layouts.get(rootId);
  layouts.delete(rootId);
  for (const id of tree ? leaves(tree) : [rootId]) stop(id);
}

// Restart a pane in place: a fresh Session of the same Agent in the same cwd
// takes the old leaf's spot, and the old one is stopped. A restarted first
// pane keeps the tab, so the layout moves to the new id.
function respawnPane(sessionId, { site, target = null, globalArgs = '' }) {
  const old = sessions.get(sessionId);
  if (!old) return { error: 'Session not found' };
  const rootId = old.paneOf || sessionId;
  const isRoot = rootId === sessionId;
  const res = launch({
    site,
    agentId: old.agentId,
    target,
    globalArgs,
    cwd: old.cwd,
    paneOf: isRoot ? null : rootId,
  });
  if (!res.ok) return res;
  const tree = layouts.get(rootId);
  if (tree) {
    const next = replaceLeaf(tree, sessionId, res.sessionId);
    if (isRoot) {
      layouts.delete(rootId);
      layouts.set(res.sessionId, next);
      rewritePaneOf(next, res.sessionId);
    } else {
      layouts.set(rootId, next);
    }
  }
  stop(sessionId);
  return { ok: true, sessionId: res.sessionId, rootId: isRoot ? res.sessionId : rootId };
}

// Graceful stop: SIGTERM, escalate to SIGKILL after a grace period (Q11).
// User-initiated dismissal also removes the persisted Session record so it does
// not return on the next launch.
function stop(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    removeSessionRecord(sessionId);
    return;
  }

  closePane(sessionId);

  if (!session.exited) {
    const res = (session.provider || activeProvider(session.scope)).stop(sessionId);
    res?.catch?.(() => {});
  }
  stopRegistryPin(session);
  sessions.delete(sessionId);
  removeSessionRecord(sessionId);
  deleteHistory(historyDir(deps.userDataDir()), sessionId);
  notifier.forget(sessionId);
  require('./chatImages.cjs')
    .clearChatImages(sessionId)
    .catch(() => {});
  emitChange({ immediate: true });
}

// App quit teardown: when keepRunningOnQuit is enabled, host-owned Sessions
// keep running in the Session Host and the client simply detaches; in-app
// Sessions are stopped and recorded as ended in the store.
function shutdownAll({ forceStop = false } = {}) {
  const now = deps.now();
  detachingForQuit = true;
  try {
    for (const session of [...sessions.values()]) {
      stopRegistryPin(session);
      if (!session.exited) {
        if (keepRunningOnQuit && !forceStop && session.isHostSession) {
          saveSessionRecord(session);
        } else {
          const res = (session.provider || activeProvider(session.scope)).stop(
            session.sessionId
          );
          res?.catch?.(() => {});
          session.exited = true;
          session.endedAt = now;
          session.exitCode = session.exitCode ?? 0;
          session.tracker.exit(session.exitCode);
          saveSessionRecord(session);
        }
      }
      sessions.delete(session.sessionId);
      notifier.forget(session.sessionId);
    }
    if (hostClient) {
      const client = hostClient;
      hostClient = null;
      hostHello = null;
      hostConnectPromise = null;
      client.close().catch(() => {});
    }
    layouts.clear();
    emitChange({ immediate: true });
  } finally {
    detachingForQuit = false;
  }
}

// Live Site Sessions only — a Floating Workspace shell is scratch and doesn't
// hold up quitting.
function hasActiveSessions() {
  for (const s of sessions.values()) if (!s.exited && s.scope !== 'floating') return true;
  return false;
}

// Distinct Site ids that have a live Session — for the quit-confirmation dialog.
function activeSiteIds() {
  const ids = new Set();
  for (const s of sessions.values()) {
    if (!s.exited && s.scope !== 'floating') ids.add(s.siteId);
  }
  return [...ids];
}

function stopAll() {
  for (const sessionId of [...sessions.keys()]) stop(sessionId);
}

const agentChat = require('./agentChat.cjs');
const {
  sendChat,
  sendChatAnswer,
  chatStop,
  chatCommand,
} = require('./agentChatSend.cjs');
// Each chat-capable Agent's transcript decoder: how a line becomes rows, and
// where a tool result's full text lives for "Show full output".
const CHAT_DECODERS = (() => {
  const claude = require('./agentChatClaude.cjs');
  const codex = require('./agentChatCodex.cjs');
  const antigravity = require('./agentChatAntigravity.cjs');
  return {
    claude: { ...claude, decodeLine: claude.decodeClaudeLine },
    codex: { ...codex, decodeLine: codex.decodeCodexLine },
    antigravity: { ...antigravity, decodeLine: antigravity.decodeAntigravityLine },
  };
})();
const transcripts = require('./transcripts.cjs');

const chatListeners = new Set();
function onChatRows(cb) {
  chatListeners.add(cb);
  return () => chatListeners.delete(cb);
}

function openChat(sessionId, viewerId) {
  const session = getSession(sessionId);
  if (!session) return;

  const agent = effectiveRegistry().find((a) => a.id === session.agentId);
  if (!agent || !agent.chat) return;

  const decoder = CHAT_DECODERS[agent.chat];
  if (!decoder) return;
  const { decodeLine } = decoder;

  const transcriptPath = locateChatTranscript(sessionId, session);
  if (!transcriptPath) {
    // Agents without a session-id flag write their transcript after the
    // first message, and a pinned transcript doesn't exist until the first
    // prompt either — keep locating until one shows up.
    if (agent.lateBind || session.transcriptId || session.transcriptPending)
      pendChatLocate(sessionId, viewerId);
    return;
  }
  if (!session.transcriptId) claimedTranscripts.set(transcriptPath, sessionId);

  // Antigravity re-maps the folder when a new conversation starts — the
  // watcher reports it like a changed transcript.
  const home = deps.homedir();
  const relocate =
    agent.chat === 'antigravity'
      ? () => {
          const convId = transcripts.antigravityConversationId(session.cwd, home);
          return convId ? transcripts.antigravityTranscriptPath(home, convId) : null;
        }
      : null;

  const opened = tryOpenChat(sessionId, viewerId, {
    transcriptPath,
    decodeLine,
    findToolResult: decoder.findToolResult,
    toolResultNeedle: decoder.toolResultNeedle,
    factScan: decoder.noteFacts
      ? { markers: decoder.FACT_MARKERS, noteFacts: decoder.noteFacts }
      : null,
    relocate,
    transcriptId: session.transcriptId,
    startedAt: session.startedAt,
    // Another live Session's own transcript is never this one's successor.
    isPinnedElsewhere: (uuid) =>
      [...sessions.values()].some(
        (s) => s.sessionId !== sessionId && !s.exited && s.transcriptId === uuid
      ),
    onRows: (rows, state, page) => {
      // Every name the batch carries, by kind ({ custom, ai, agent }); the
      // last of each kind wins, as Claude re-appends them when they change.
      let header = undefined;
      const filteredRows = [];
      for (const row of rows) {
        if (row.isHeader) {
          header = { ...header, [row.kind || 'ai']: row.title };
        } else {
          filteredRows.push(row);
        }
      }
      // Only the facts (tasks, to-dos, usage) — never the decoder's whole
      // state, which holds every message of the loaded pages.
      const atStart = typeof page?.atStart === 'boolean' ? { atStart: page.atStart } : {};
      for (const cb of chatListeners)
        cb({ sessionId, rows: filteredRows, header, state: state?.facts, ...atStart });
    },
  });
  // The file can go between locating and opening it (a moved Site, a
  // cleared conversation): keep locating instead of failing the IPC call.
  if (!opened && (agent.lateBind || session.transcriptId || session.transcriptPending)) {
    claimedTranscripts.delete(transcriptPath);
    pendChatLocate(sessionId, viewerId);
  }
}

function tryOpenChat(sessionId, viewerId, opts) {
  try {
    agentChat.openChat(sessionId, viewerId, opts);
    return true;
  } catch {
    return false;
  }
}

// One rollout drives at most one Session: the first Session to claim it.
// Claims by other live Sessions are excluded from locating; a claim dies
// with its Session (or once its Agent has exited), and a Session always
// reclaims its own path. Pinned Sessions never claim and are never blocked:
// their transcript is theirs by construction — the --session-id they were
// launched with, or the one a Resume continues after the old Session ended.
const claimedTranscripts = new Map(); // transcriptPath -> sessionId
const pendingChatLocates = new Map(); // sessionId -> { viewers: Set, timer }
const CHAT_LOCATE_RETRY_MS = 2000;

function claimHeld(owner, sessionId) {
  if (owner === sessionId) return false;
  const s = sessions.get(owner);
  return !!s && !s.exited && s.tracker.snapshot().state !== 'exited';
}

function locateChatTranscript(sessionId, session) {
  // Claude hasn't registered its conversation yet: recency would guess.
  if (session.transcriptPending && !session.transcriptId) return null;
  const exclude = new Set();
  if (!session.transcriptId) {
    for (const [transcriptPath, owner] of claimedTranscripts) {
      if (claimHeld(owner, sessionId)) exclude.add(transcriptPath);
    }
  }
  // Home comes from this module's deps: the transcripts module's own seam
  // is a different instance once bundled, so its homedir is not ours.
  const found = transcripts.locateTranscript(
    session.agentId,
    session.cwd,
    session.startedAt,
    session.transcriptId,
    exclude,
    deps.homedir()
  );
  if (!found) return null;
  if (session.transcriptId) return found;
  const owner = claimedTranscripts.get(found);
  if (owner && claimHeld(owner, sessionId)) return null;
  return found;
}

function pendChatLocate(sessionId, viewerId) {
  let pending = pendingChatLocates.get(sessionId);
  if (!pending) {
    pending = { viewers: new Set(), timer: null };
    pendingChatLocates.set(sessionId, pending);
    pending.timer = setInterval(() => {
      const session = getSession(sessionId);
      if (!session) {
        clearInterval(pending.timer);
        pendingChatLocates.delete(sessionId);
        return;
      }
      const transcriptPath = locateChatTranscript(sessionId, session);
      if (!transcriptPath) return;
      clearInterval(pending.timer);
      pendingChatLocates.delete(sessionId);
      for (const viewer of pending.viewers) openChat(sessionId, viewer);
    }, CHAT_LOCATE_RETRY_MS);
  }
  pending.viewers.add(viewerId);
}

function chatLoadOlder(sessionId) {
  return agentChat.loadOlder(sessionId);
}

function chatFetchFull(sessionId, toolUseId) {
  return agentChat.chatFetchFull(sessionId, toolUseId);
}

function chatExpandSubagent(sessionId, toolUseId, expanded) {
  return agentChat.chatExpandSubagent(sessionId, toolUseId, expanded);
}

function chatLoadOlderSubagent(sessionId, parentId) {
  return agentChat.chatLoadOlderSubagent(sessionId, parentId);
}

function closeChat(sessionId, viewerId) {
  const pending = pendingChatLocates.get(sessionId);
  if (pending) {
    pending.viewers.delete(viewerId);
    if (pending.viewers.size === 0) {
      clearInterval(pending.timer);
      pendingChatLocates.delete(sessionId);
    }
  }
  agentChat.closeChat(sessionId, viewerId);
}

function closeAllChats() {
  for (const [, pending] of pendingChatLocates) clearInterval(pending.timer);
  pendingChatLocates.clear();
  agentChat.closeAllChats();
}

function chatAnswer(sessionId, groups) {
  const session = getSession(sessionId);
  if (!session) return Promise.reject(new Error('No session'));
  return sendChatAnswer(session, groups);
}

function chatSend(sessionId, text, images = []) {
  const session = getSession(sessionId);
  if (!session) return Promise.reject(new Error('No session'));
  return sendChat(session, text, images);
}

// Interrupt a working Agent with a single Esc. Cancels any pending delayed
// Enter first, so nothing stale submits after the interrupt.
function chatInterrupt(sessionId) {
  const session = getSession(sessionId);
  if (!session) return Promise.reject(new Error('No session'));
  return chatStop(session);
}

// Switch the Agent's model via `/model <id>`. Queued on the send serialiser
// behind any in-flight send, so it never lands on a dialog or interleaves.
function chatModel(sessionId, modelId) {
  const session = getSession(sessionId);
  if (!session) return Promise.reject(new Error('No session'));
  if (!modelId || typeof modelId !== 'string')
    return Promise.reject(new Error('No model'));
  return chatCommand(session, `/model ${modelId}`);
}

function chatImage(sessionId, ref) {
  return agentChat.chatImage(sessionId, ref);
}

function chatSnapshot(sessionId, lines = 15) {
  const session = getSession(sessionId);
  if (!session) return '';
  const { snapshotBuffer } = require('./ansi.cjs');
  return snapshotBuffer(session.buffer, lines);
}

module.exports = {
  SHELL_ID,
  SESSIONS_STORE_KEY,
  MAX_ENDED_SESSIONS_PER_PROJECT,
  bindStore,
  restoreSessions,
  shutdownAll,
  setKeepRunningOnQuit,
  getKeepRunningOnQuit,
  initSessionHost,
  getHostStatus,
  onHostStatusChanged,
  setConfig,
  effectiveRegistry,
  listAgents,
  resolveBin,
  shellQuote,
  resolveShellEnv,
  stripParentAgentEnv,
  PARENT_AGENT_ENV_KEYS,
  isWrapperShim,
  installAgent,
  brewInstallArgs,
  npmInstallArgs,
  installScriptUrl,
  assertShellScript,
  listSessions,
  listAllSessions,
  listFloatingSessions,
  onSessionsChanged,
  onChatRows,
  openChat,
  closeChat,
  closeAllChats,
  chatSend,
  chatAnswer,
  chatInterrupt,
  chatModel,
  chatLoadOlder,
  chatFetchFull,
  chatExpandSubagent,
  chatLoadOlderSubagent,
  chatImage,
  onFloatingSessionsChanged,
  resolveLaunch,
  launch,
  launchFloating,
  resumeChatSession,
  attach,
  write,
  setView,
  markRead,
  onAlert,
  setNotificationSettings,
  clearBuffer,
  resize,
  splitPane,
  setPaneRatio,
  renameSession,
  setSessionPinned,
  setSessionColor,
  TAB_COLOR_VALUES,
  stop,
  stopTab,
  respawnPane,
  getSession,
  getBuffer,
  chatSnapshot,
  hasActiveSessions,
  activeSiteIds,
  stopAll,
  __setDeps,
};
