'use strict';

// ── Claude Code hook installer ───────────────────────────────
// Port of claude-agent-verse packages/server/src/hooks-cli.ts (see
// test/office-hooks-installer.test.js for the ported cases), retargeted:
//
// - The settings file is ~/.claude/settings.json — verified as where the real
//   tools on a dev machine (Orca, Agent Flow, Superset) register their hooks —
//   not the source's ~/.claude.json. $CLAUDE_HOME still overrides the
//   directory, as in the source.
// - The entry uses that file's matcher-wrapper shape
//   ({ hooks: [{ type: 'command', command }] }) rather than the source's bare
//   { type, command }, so Claude Code actually runs it alongside coexisting
//   tools' entries. updateHooks' array/scalar shape preservation is kept
//   verbatim, which is what round-trips those coexisting entries untouched.
// - The command is `'<node>' '<userData>/wpxen-hook-forwarder.cjs' # wpxen`:
//   the system node's ABSOLUTE path, resolved once at install through the
//   login-shell PATH (the agents.cjs precedent — ELECTRON_RUN_AS_NODE was
//   rejected in spec #178 because a baked app path goes stale), the forwarder
//   copied into userData, and the tag as a trailing shell comment, visible in
//   the settings JSON. Claude Code runs hooks with its own PATH, which need not
//   hold the user's node (nvm, Volta), so the path is pinned. Its failure mode:
//   the pinned node can go away (an nvm version removed); status() reports it
//   and a reinstall re-pins. Earlier builds wrote bare `node "<forwarder>"`; the
//   tag still identifies those, install replaces them in place.
// - Legacy generation cleanup (the sudoers.cjs LEGACY_* precedent): both
//   install and uninstall strip entries bearing LEGACY_HOOK_TAGS in the same
//   edit, and sweep them out of the previous generation's settings file
//   (~/.claude.json) too — a leftover hook entry there would keep spawning a
//   forwarder for a server that no longer exists.
// - Preview, then apply — the source's main() sequence, split so the diff is
//   surfaced BEFORE the write (#187). preview() computes every file's diff
//   (settings.json plus the legacy sweep) and writes nothing; the Settings UI
//   shows it and asks for a confirm; apply() then backs up to .bak, stages to
//   .tmp and renames it over the file (atomic). The preview's token pins what
//   was shown: apply refuses if any file changed in between.
//
// Electron-free at module scope (the ratchet test): the userData path resolves
// lazily, and tests swap every effect through deps/__setDeps.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const agents = require('../agents.cjs');
const { claudeHome } = require('./scanner.cjs');

// ── Naming law constants (CLAUDE.md "Legacy names") ─────────────────────────
// These three ride outside the app bundle (the user's Claude settings and
// userData), so a future rename must migrate them; they sit here beside the
// legacy list they would join.
/** Tag marking WPXen's hook entries in the user's Claude settings. */
const WPXEN_HOOK_TAG = '# wpxen';
/** The forwarder script's filename inside userData. */
const WPXEN_FORWARDER_FILENAME = 'wpxen-hook-forwarder.cjs';
/** Tags of previous generations, stripped by install AND uninstall. */
const LEGACY_HOOK_TAGS = ['# claude-agent-verse'];

// Every hook type the forwarder is registered for — the source's list. The
// reducer reacts to five today; the breadth is kept so future reducer work
// needs no reinstall.
const HOOK_TYPES = [
  'SessionStart',
  'SessionEnd',
  'Notification',
  'PermissionRequest',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'SubagentStart',
  'SubagentStop',
];

// ── Deps seam ────────────────────────────────────────────────────────────────

function defaultSettingsPath() {
  return path.join(claudeHome(), 'settings.json');
}

let overrides = {};

const deps = {
  /** The user's global Claude settings file. */
  get settingsPath() {
    return 'settingsPath' in overrides ? overrides.settingsPath : defaultSettingsPath;
  },
  /** Previous generations' settings files, swept for legacy tags only. */
  get legacySettingsPaths() {
    return 'legacySettingsPaths' in overrides
      ? overrides.legacySettingsPaths
      : () => [path.join(os.homedir(), '.claude.json')];
  },
  /** The app's userData directory — where the forwarder and socket live. */
  get userDataPath() {
    return 'userDataPath' in overrides
      ? overrides.userDataPath
      : // Lazy: never at module scope (the ratchet), and only install paths hit it.
        () => require('electron').app.getPath('userData');
  },
  /** Login-shell env snapshot, for finding the system `node` on the real PATH. */
  get shellEnv() {
    return 'shellEnv' in overrides ? overrides.shellEnv : agents.resolveShellEnv;
  },
};

function __setDeps(next) {
  overrides = { ...overrides, ...next };
}

/** Test-only: drop every dep override. */
function __reset() {
  overrides = {};
}

// ── Tag detection ────────────────────────────────────────────────────────────

// A hook entry may be a bare string, a { command } object (the source's shape),
// or a matcher-wrapper { hooks: [{ command }] } (the real settings.json shape).
// Anything else is not ours.
function isTaggedBy(entry, tags) {
  const has = (s) => typeof s === 'string' && tags.some((t) => s.includes(t));
  if (has(entry)) return true;
  if (entry && typeof entry === 'object') {
    if (has(entry.command)) return true;
    if (Array.isArray(entry.hooks)) {
      return entry.hooks.some(
        (h) => has(h) || (h && typeof h === 'object' && has(h.command))
      );
    }
  }
  return false;
}

function isWpxenTagged(entry) {
  return isTaggedBy(entry, [WPXEN_HOOK_TAG]);
}

function isLegacyTagged(entry) {
  return isTaggedBy(entry, LEGACY_HOOK_TAGS);
}

// ── The command ──────────────────────────────────────────────────────────────

// POSIX single-quoting: everything inside '…' is literal to sh, so a path with
// spaces, $, `, " or \ can't become shell syntax; a ' itself is closed,
// escaped and reopened ('\'').
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** The tagged command Claude Code runs: pinned node, then the forwarder. */
function forwarderCommandFor(nodeBin, forwarderPath) {
  return `${shellQuote(nodeBin)} ${shellQuote(forwarderPath)} ${WPXEN_HOOK_TAG}`;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const QUOTED = `'((?:[^']|'\\\\'')*)'`;
const PINNED_RE = new RegExp(`^${QUOTED} ${QUOTED} ${escapeRe(WPXEN_HOOK_TAG)}$`);
// What builds before the node path was pinned wrote.
const BARE_RE = new RegExp(`^node "([^"]*)" ${escapeRe(WPXEN_HOOK_TAG)}$`);
const unquote = (s) => s.replace(/'\\''/g, "'");

/**
 * The paths a tagged command runs, or null when it isn't one we wrote.
 * nodePath is null for the bare-`node` form an earlier build wrote.
 * @param {string} command
 * @returns {{ nodePath: string | null, forwarderPath: string } | null}
 */
function parseForwarderCommand(command) {
  if (typeof command !== 'string') return null;
  const pinned = PINNED_RE.exec(command);
  if (pinned) return { nodePath: unquote(pinned[1]), forwarderPath: unquote(pinned[2]) };
  const bare = BARE_RE.exec(command);
  if (bare) return { nodePath: null, forwarderPath: bare[1] };
  return null;
}

// ── The pure edit (ported updateHooks) ───────────────────────────────────────

/**
 * Pure: returns the next settings for an install or uninstall, never mutating
 * the input. Shape preservation is the coexistence guarantee — a bare value
 * stays a bare value, an array stays an array, an emptied key (then an emptied
 * hooks object) is deleted. Legacy-tagged entries are stripped by BOTH verbs.
 * Install replaces a stale tagged entry (an older command) in place, so a
 * reinstall re-pins node rather than adding a second entry.
 *
 * @param {object} settings Parsed settings JSON.
 * @param {'install' | 'uninstall'} command
 * @param {string} forwarderCommand The tagged command string to install.
 * @returns {{ changed: boolean, nextSettings: object }}
 */
function updateHooks(settings, command, forwarderCommand) {
  const nextSettings = JSON.parse(JSON.stringify(settings)); // deep copy
  if (!nextSettings.hooks) nextSettings.hooks = {};

  const newHookEntry = { hooks: [{ type: 'command', command: forwarderCommand }] };
  const isCurrent = (entry) => JSON.stringify(entry) === JSON.stringify(newHookEntry);

  let changed = false;

  for (const hookName of HOOK_TYPES) {
    const current = nextSettings.hooks[hookName];
    const wasArray = Array.isArray(current);
    const wasMissing = current === undefined;

    let currentArr = wasArray ? [...current] : wasMissing ? [] : [current];

    // Legacy generation cleanup, on install and uninstall alike.
    const beforeLegacy = currentArr.length;
    currentArr = currentArr.filter((entry) => !isLegacyTagged(entry));
    if (currentArr.length !== beforeLegacy) changed = true;

    if (command === 'install') {
      // The first tagged entry becomes the current one where it stands; any
      // further tagged entries are duplicates and go.
      let placed = false;
      const nextArr = [];
      for (const entry of currentArr) {
        if (!isWpxenTagged(entry)) {
          nextArr.push(entry);
        } else if (!placed) {
          nextArr.push(newHookEntry);
          placed = true;
          if (!isCurrent(entry)) changed = true;
        } else {
          changed = true;
        }
      }
      if (!placed) {
        nextArr.push(newHookEntry);
        changed = true;
      }
      currentArr = nextArr;
    } else if (command === 'uninstall') {
      const beforeLen = currentArr.length;
      currentArr = currentArr.filter((entry) => !isWpxenTagged(entry));
      if (currentArr.length !== beforeLen) changed = true;
    }

    if (currentArr.length === 0) {
      delete nextSettings.hooks[hookName];
    } else if (currentArr.length === 1 && !wasArray) {
      nextSettings.hooks[hookName] = currentArr[0];
    } else {
      nextSettings.hooks[hookName] = currentArr;
    }
  }

  if (Object.keys(nextSettings.hooks).length === 0) {
    delete nextSettings.hooks;
  }

  return { changed, nextSettings };
}

/** Pure: strip legacy-tagged entries (never add anything). */
function sweepLegacy(settings) {
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    return { changed: false, nextSettings: settings };
  }
  const next = JSON.parse(JSON.stringify(settings));
  let changed = false;
  for (const [hookName, value] of Object.entries(next.hooks)) {
    const wasArray = Array.isArray(value);
    let arr = wasArray ? [...value] : [value];
    const before = arr.length;
    arr = arr.filter((entry) => !isLegacyTagged(entry));
    if (arr.length === before) continue;
    changed = true;
    if (arr.length === 0) delete next.hooks[hookName];
    else if (arr.length === 1 && !wasArray) next.hooks[hookName] = arr[0];
    else next.hooks[hookName] = arr;
  }
  if (changed && Object.keys(next.hooks).length === 0) delete next.hooks;
  return { changed, nextSettings: next };
}

// ── File plumbing ────────────────────────────────────────────────────────────

const serialize = (settings) => JSON.stringify(settings, null, 2) + '\n';

// The file's text, or null when it doesn't exist. Anything else throws (never
// silently clobber a file that exists but can't be read).
function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Parse a settings file; a missing file is a fresh {}.
function readSettingsFile(filePath) {
  const content = readText(filePath);
  return content === null ? {} : JSON.parse(content);
}

// A unified diff of the planned write, computed without writing: the new
// text goes to diff on stdin. diff exits 1 when the files differ — the
// expected case — so stdout is taken regardless of status.
function diffText(filePath, current, next) {
  try {
    const res = spawnSync(
      'diff',
      [
        '-u',
        '--label',
        filePath,
        '--label',
        filePath,
        current === null ? '/dev/null' : filePath,
        '-',
      ],
      { encoding: 'utf8', input: next }
    );
    if (typeof res.stdout === 'string' && res.stdout) return res.stdout;
  } catch {
    // fall through
  }
  return `Changes to ${filePath} (diff unavailable).`;
}

// The final write: back up, stage to .tmp beside the real file (through a
// symlink, so a dotfiles link survives), carry the mode over, then rename —
// atomic, so Claude Code never reads a half-written settings file.
function writeSettingsFile(filePath, text) {
  let target = filePath;
  let mode = null;
  try {
    target = fs.realpathSync(filePath);
    mode = fs.statSync(target).mode & 0o777;
    fs.copyFileSync(target, `${filePath}.bak`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  const tempPath = `${target}.tmp`;
  try {
    fs.writeFileSync(tempPath, text, mode === null ? undefined : { mode });
    if (mode !== null) fs.chmodSync(tempPath, mode); // writeFile's mode is umask-masked
    fs.renameSync(tempPath, target);
  } catch (err) {
    fs.rmSync(tempPath, { force: true });
    throw err;
  }
}

// ── Public surface ───────────────────────────────────────────────────────────

const COMMANDS = ['install', 'uninstall'];

function forwarderPath() {
  return path.join(deps.userDataPath(), WPXEN_FORWARDER_FILENAME);
}

// The system node's absolute path, through the login-shell environment.
function resolveNode() {
  const nodeBin = agents.resolveBin('node', deps.shellEnv());
  if (!nodeBin) {
    throw new Error(
      'node was not found on your PATH. The hook runs through the system node — ' +
        'install it with `brew install node` (or from nodejs.org) and try again.'
    );
  }
  return path.resolve(nodeBin);
}

// Everything a verb would write, as text, without writing it.
function plan(command) {
  if (!COMMANDS.includes(command)) throw new Error(`Unknown hook command: ${command}`);
  const nodeBin = command === 'install' ? resolveNode() : null;
  const dest = forwarderPath();

  const settingsPath = deps.settingsPath();
  const current = readText(settingsPath);
  const settings = current === null ? {} : JSON.parse(current);
  const forwarderCommand = nodeBin ? forwarderCommandFor(nodeBin, dest) : '';
  const { changed, nextSettings } = updateHooks(settings, command, forwarderCommand);

  // Previous generations' files: swept, never installed into. Unreadable or
  // absent ones are left alone.
  const legacy = deps.legacySettingsPaths().map((filePath) => {
    let text;
    let swept;
    try {
      text = readText(filePath);
      swept = sweepLegacy(text === null ? {} : JSON.parse(text));
    } catch {
      return { path: filePath, current: null, changed: false };
    }
    return {
      path: filePath,
      current: text,
      changed: swept.changed,
      next: swept.changed ? serialize(swept.nextSettings) : undefined,
    };
  });

  const settingsFile = {
    path: settingsPath,
    current,
    changed,
    next: changed ? serialize(nextSettings) : undefined,
  };
  const token = crypto
    .createHash('sha256')
    .update(JSON.stringify([command, settingsFile, legacy]))
    .digest('hex');
  return { command, nodeBin, forwarderPath: dest, settingsFile, legacy, token };
}

/**
 * Compute what install or uninstall would change — the settings.json diff and
 * the legacy sweep's — and write nothing. Throws with a clear hint when
 * install can't find `node`.
 * @param {'install' | 'uninstall'} command
 */
function preview(command) {
  const p = plan(command);
  const { settingsFile } = p;
  return {
    command,
    changed: settingsFile.changed,
    diff: settingsFile.changed
      ? diffText(settingsFile.path, settingsFile.current, settingsFile.next)
      : null,
    settingsPath: settingsFile.path,
    legacy: p.legacy.map((l) => ({
      path: l.path,
      changed: l.changed,
      diff: l.changed ? diffText(l.path, l.current, l.next) : null,
    })),
    nodeBin: p.nodeBin,
    forwarderPath: p.forwarderPath,
    token: p.token,
  };
}

/**
 * Perform install or uninstall. With the token from preview(), refuses when
 * any file changed since — the diff the user confirmed is the one written.
 * Install copies the forwarder into userData first (so the command the
 * entries point at exists by the time Claude Code reads them, and a reinstall
 * refreshes it); uninstall deletes it after.
 * @param {'install' | 'uninstall'} command
 * @param {{ token?: string }} [opts]
 */
function apply(command, { token } = {}) {
  const p = plan(command);
  if (token !== undefined && token !== p.token) {
    throw new Error(
      'Your Claude settings changed since the preview. Review the new changes and try again.'
    );
  }

  if (command === 'install') {
    fs.mkdirSync(path.dirname(p.forwarderPath), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'forwarder.cjs'), p.forwarderPath);
  }

  if (p.settingsFile.changed) writeSettingsFile(p.settingsFile.path, p.settingsFile.next);
  for (const l of p.legacy) if (l.changed) writeSettingsFile(l.path, l.next);

  if (command === 'uninstall') {
    try {
      fs.rmSync(p.forwarderPath, { force: true });
    } catch {
      // A lingering forwarder is inert: nothing references it after the edit.
    }
  }

  return {
    command,
    changed: p.settingsFile.changed,
    settingsPath: p.settingsFile.path,
    forwarderPath: p.forwarderPath,
    nodeBin: p.nodeBin,
    legacy: p.legacy.map((l) => ({ path: l.path, changed: l.changed })),
  };
}

const PROBLEMS = {
  'forwarder-missing': 'The hook forwarder is missing from WPXen’s data folder.',
  'node-missing': 'The node the hook was installed with no longer exists.',
  'node-unpinned':
    'Installed by an earlier WPXen with a bare `node` — reinstall to pin node’s path.',
  unrecognized: 'A wpxen-tagged hook entry was edited by hand.',
};

const exists = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

// Every command string carried by a tagged entry.
function taggedCommands(settings) {
  const out = new Set();
  if (!settings.hooks || typeof settings.hooks !== 'object') return out;
  for (const value of Object.values(settings.hooks)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (!isWpxenTagged(entry)) continue;
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [entry];
      for (const h of hooks) {
        const cmd = typeof h === 'string' ? h : h?.command;
        if (typeof cmd === 'string' && cmd.includes(WPXEN_HOOK_TAG)) out.add(cmd);
      }
    }
  }
  return out;
}

/**
 * Installed means any hook entry bears our tag; healthy means every tagged
 * command would actually run — its pinned node and its forwarder both exist.
 * File stats only, so the Settings page can poll it.
 */
function status() {
  const settingsPath = deps.settingsPath();
  let commands = new Set();
  try {
    commands = taggedCommands(readSettingsFile(settingsPath));
  } catch {
    // unreadable reads as not installed
  }
  const installed = commands.size > 0;
  const forwarderPresent = exists(forwarderPath());

  let problem = null;
  let nodePath = null;
  const flag = (code) => {
    // Keep the most serious: the order in PROBLEMS.
    const order = Object.keys(PROBLEMS);
    if (!problem || order.indexOf(code) < order.indexOf(problem)) problem = code;
  };
  for (const cmd of commands) {
    const parsed = parseForwarderCommand(cmd);
    if (!parsed) {
      flag('unrecognized');
      continue;
    }
    if (!exists(parsed.forwarderPath)) flag('forwarder-missing');
    if (parsed.nodePath === null) flag('node-unpinned');
    else {
      nodePath = parsed.nodePath;
      if (!exists(parsed.nodePath)) flag('node-missing');
    }
  }

  return {
    installed,
    healthy: installed && !problem,
    problem: problem ? { code: problem, message: PROBLEMS[problem] } : null,
    nodePath,
    forwarderPresent,
    settingsPath,
  };
}

module.exports = {
  HOOK_TYPES,
  WPXEN_HOOK_TAG,
  WPXEN_FORWARDER_FILENAME,
  LEGACY_HOOK_TAGS,
  updateHooks,
  forwarderCommandFor,
  parseForwarderCommand,
  preview,
  apply,
  status,
  __setDeps,
  __reset,
};
