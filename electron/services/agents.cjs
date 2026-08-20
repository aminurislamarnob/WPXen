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
    id: 'codex',
    name: 'Codex',
    cmd: 'codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust',
    install: 'npm install -g @openai/codex',
    installer: { kind: 'brew', name: 'codex', cask: true },
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
        defaultCmd: a.defaultCmd,
        install: a.install,
        // Present only when a one-click install is available; the UI keys the
        // Install button off this and branches on `kind` for its wording.
        installer: a.installer ? { ...a.installer } : null,
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
  runBrewStreaming: (args, onProgress) =>
    require('./brew.cjs').runBrewStreaming(args, onProgress),
  isBrewInstalled: () => require('./brew.cjs').isBrewInstalled(),
  runScriptStreaming: (url, onProgress) => runVendorScript(url, onProgress),
  runNpmStreaming: (args, onProgress) => runNpmInstall(args, onProgress),
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
  resolveBin,
  isWrapperShim,
  installAgent,
  brewInstallArgs,
  npmInstallArgs,
  installScriptUrl,
  assertShellScript,
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
