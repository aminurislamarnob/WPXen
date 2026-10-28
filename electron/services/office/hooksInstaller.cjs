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
// - The command is `node "<userData>/wpxen-hook-forwarder.cjs" # wpxen`: the
//   system node (verified at install via the login-shell PATH, the agents.cjs
//   precedent — ELECTRON_RUN_AS_NODE was rejected in spec #178 because a baked
//   app path goes stale), the forwarder copied into userData, and the tag as a
//   trailing shell comment, visible in the settings JSON.
// - Legacy generation cleanup (the sudoers.cjs LEGACY_* precedent): both
//   install and uninstall strip entries bearing LEGACY_HOOK_TAGS in the same
//   edit, and sweep them out of the previous generation's settings file
//   (~/.claude.json) too — a leftover hook entry there would keep spawning a
//   forwarder for a server that no longer exists.
// - Backup to .bak, stage to .tmp, surface a diff, then the final write — the
//   source's main() sequence, with the diff returned to the Settings UI
//   instead of printed.
//
// Electron-free at module scope (the ratchet test): the userData path resolves
// lazily, and tests swap every effect through deps/__setDeps.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const agents = require('../agents.cjs');

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
  const home = process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
  return path.join(home, 'settings.json');
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

// ── The pure edit (ported updateHooks) ───────────────────────────────────────

function forwarderCommandFor(forwarderPath) {
  // Quoted: the real userData path contains spaces (…/Application Support/…).
  return `node "${forwarderPath}" ${WPXEN_HOOK_TAG}`;
}

/**
 * Pure: returns the next settings for an install or uninstall, never mutating
 * the input. Shape preservation is the coexistence guarantee — a bare value
 * stays a bare value, an array stays an array, an emptied key (then an emptied
 * hooks object) is deleted. Legacy-tagged entries are stripped by BOTH verbs.
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
      if (!currentArr.some(isWpxenTagged)) {
        currentArr.push(newHookEntry);
        changed = true;
      }
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

// ── File plumbing ────────────────────────────────────────────────────────────

// Parse a settings file; a missing file is a fresh {}, anything else throws
// (never silently clobber a file that exists but can't be read).
function readSettingsFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  return JSON.parse(content);
}

// The source's main() write sequence: backup (when the file exists), stage to
// .tmp, diff the staged file against the current one, then the final write.
// Returns the diff text for the Settings UI.
function writeSettingsFile(filePath, nextSettings) {
  const serialized = JSON.stringify(nextSettings, null, 2) + '\n';
  const existed = fs.existsSync(filePath);

  if (existed) fs.copyFileSync(filePath, `${filePath}.bak`);
  else fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, serialized);

  let diff;
  try {
    // diff exits 1 when the files differ — that's the expected case, so take
    // stdout regardless of status. /dev/null stands in for a fresh file.
    const res = spawnSync('diff', ['-u', existed ? filePath : '/dev/null', tempPath], {
      encoding: 'utf8',
    });
    diff = typeof res.stdout === 'string' && res.stdout ? res.stdout : null;
  } catch {
    diff = null;
  }
  if (!diff) diff = 'Changes applied (diff unavailable).';

  fs.writeFileSync(filePath, serialized);
  return diff;
}

// Strip legacy-tagged entries (never add anything) from one previous-generation
// settings file. Unreadable or absent files are left alone.
function sweepLegacyFile(filePath) {
  let settings;
  try {
    settings = readSettingsFile(filePath);
  } catch {
    return { path: filePath, changed: false };
  }
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    return { path: filePath, changed: false };
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

  if (!changed) return { path: filePath, changed: false };
  writeSettingsFile(filePath, next);
  return { path: filePath, changed: true };
}

function sweepLegacyFiles() {
  return deps.legacySettingsPaths().map(sweepLegacyFile);
}

// ── Public surface ───────────────────────────────────────────────────────────

function forwarderPath() {
  return path.join(deps.userDataPath(), WPXEN_FORWARDER_FILENAME);
}

/**
 * Install the hook: verify `node`, copy the forwarder into userData, add the
 * tagged entries (stripping legacy ones), and sweep the legacy settings file.
 * Throws with a clear hint when `node` is missing.
 */
function install() {
  const env = deps.shellEnv();
  const nodeBin = agents.resolveBin('node', env);
  if (!nodeBin) {
    throw new Error(
      'node was not found on your PATH. The hook runs through the system node — ' +
        'install it with `brew install node` (or from nodejs.org) and try again.'
    );
  }

  const settingsPath = deps.settingsPath();
  const settings = readSettingsFile(settingsPath);

  // Copied before the settings edit, so the command the entries point at exists
  // by the time Claude Code reads them. Also refreshes the copy on re-install.
  const dest = forwarderPath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'forwarder.cjs'), dest);

  const { changed, nextSettings } = updateHooks(
    settings,
    'install',
    forwarderCommandFor(dest)
  );

  let diff = null;
  if (changed) diff = writeSettingsFile(settingsPath, nextSettings);

  const legacy = sweepLegacyFiles();
  return { changed, diff, settingsPath, forwarderPath: dest, nodeBin, legacy };
}

/**
 * Uninstall: remove exactly the tagged entries (legacy ones included), delete
 * the forwarder from userData, and sweep the legacy settings file.
 */
function uninstall() {
  const settingsPath = deps.settingsPath();
  const settings = readSettingsFile(settingsPath);

  const dest = forwarderPath();
  const { changed, nextSettings } = updateHooks(
    settings,
    'uninstall',
    forwarderCommandFor(dest)
  );

  let diff = null;
  if (changed) diff = writeSettingsFile(settingsPath, nextSettings);

  try {
    fs.rmSync(dest, { force: true });
  } catch {
    // A lingering forwarder is inert: nothing references it after the edit.
  }

  const legacy = sweepLegacyFiles();
  return { changed, diff, settingsPath, forwarderPath: dest, legacy };
}

/** Installed means: any hook entry in the settings file bears our tag. */
function status() {
  const settingsPath = deps.settingsPath();
  let installed = false;
  try {
    const settings = readSettingsFile(settingsPath);
    if (settings.hooks && typeof settings.hooks === 'object') {
      installed = Object.values(settings.hooks).some((value) =>
        (Array.isArray(value) ? value : [value]).some(isWpxenTagged)
      );
    }
  } catch {
    installed = false;
  }

  let forwarderPresent = false;
  try {
    forwarderPresent = fs.existsSync(forwarderPath());
  } catch {
    forwarderPresent = false;
  }

  return { installed, forwarderPresent, settingsPath };
}

module.exports = {
  HOOK_TYPES,
  WPXEN_HOOK_TAG,
  WPXEN_FORWARDER_FILENAME,
  LEGACY_HOOK_TAGS,
  updateHooks,
  install,
  uninstall,
  status,
  __setDeps,
  __reset,
};
