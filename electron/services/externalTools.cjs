'use strict';

// Which app opens a file, a folder or a terminal.
//
// Before this, WPXen handed everything to `shell.openPath` and let macOS
// decide — which meant "Open in editor" landed wherever Launch Services
// pointed, often Xcode or TextEdit. Each editor here maps to the CLI shim it
// installs on $PATH; if that shim isn't there we fall back to `shell.openPath`
// rather than failing, so an unconfigured machine behaves exactly as before.

// Process-launching seam. Held in an object rather than destructured at import
// so tests can swap it — these .cjs modules load through Node's CJS loader,
// out of reach of vi.mock on a builtin.
const proc = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const deps = {
  execFile: proc.execFile,
  execFileSync: proc.execFileSync,
  isDirectory: (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  // The app macOS opens code files with, or null. See defaultCodeEditor.
  defaultCodeEditor: () => defaultCodeEditor(),
};

// `open -a` needs the bundle name; the CLI shim is what we probe for, because
// a user who never ran "Install 'code' command in PATH" should fall through to
// the OS default rather than get a silent no-op.
const EDITORS = {
  vscode: { label: 'Visual Studio Code', bin: 'code', app: 'Visual Studio Code' },
  cursor: { label: 'Cursor', bin: 'cursor', app: 'Cursor' },
  phpstorm: { label: 'PhpStorm', bin: 'phpstorm', app: 'PhpStorm' },
  sublime: { label: 'Sublime Text', bin: 'subl', app: 'Sublime Text' },
  zed: { label: 'Zed', bin: 'zed', app: 'Zed' },
};

const TERMINALS = {
  terminal: { label: 'Terminal', app: 'Terminal' },
  iterm: { label: 'iTerm2', app: 'iTerm' },
  warp: { label: 'Warp', app: 'Warp' },
  ghostty: { label: 'Ghostty', app: 'Ghostty' },
};

// `which` results are stable for a session and this is called from render
// paths, so cache them.
const whichCache = new Map();

function resolveBin(bin) {
  if (whichCache.has(bin)) return whichCache.get(bin);
  let resolved = null;
  try {
    // Login shell so the user's PATH additions (Homebrew, ~/.local/bin) count.
    resolved =
      deps
        .execFileSync('/bin/sh', ['-lc', `command -v ${JSON.stringify(bin)}`], {
          encoding: 'utf8',
          timeout: 3000,
        })
        .trim() || null;
  } catch {
    resolved = null;
  }
  whichCache.set(bin, resolved);
  return resolved;
}

function appExists(appName) {
  const key = `app:${appName}`;
  if (whichCache.has(key)) return whichCache.get(key);
  let found = false;
  try {
    // -R lists the registered bundle path; a miss exits non-zero.
    deps
      .execFileSync('/usr/bin/mdfind', [`kMDItemFSName == '${appName}.app'`], {
        encoding: 'utf8',
        timeout: 3000,
      })
      .trim()
      .split('\n')
      .filter(Boolean)
      .forEach(() => {
        found = true;
      });
  } catch {
    found = false;
  }
  whichCache.set(key, found);
  return found;
}

/** Editors and terminals with a detected/not-detected flag, for the UI. */
function listTools() {
  return {
    editors: Object.entries(EDITORS).map(([id, e]) => ({
      id,
      label: e.label,
      detected: !!resolveBin(e.bin) || appExists(e.app),
    })),
    terminals: Object.entries(TERMINALS).map(([id, t]) => ({
      id,
      label: t.label,
      detected: appExists(t.app),
    })),
  };
}

function spawnDetached(cmd, args) {
  const child = deps.execFile(cmd, args, { timeout: 0 }, () => {});
  // Detach so a long-lived editor process isn't tied to the app's lifetime.
  child?.unref?.();
}

/**
 * Opens a path in an editor. The order is:
 *
 *   1. WPXen's own setting (Settings → External Tools): a named editor or a
 *      custom command, when it's installed.
 *   2. Otherwise a file goes to its macOS default app, as it always has.
 *      A folder goes to the macOS default *code* editor instead (the app
 *      that opens .php/.js/…): a folder's own default is Finder, which is
 *      never what "Open in Editor" means.
 *   3. A folder with no default code editor opens nothing and returns
 *      { ok: false, needsChoice: true }, so the caller can ask the user.
 *
 * @param {string} target        absolute path
 * @param {object} settings      { editor, customCommand }
 * @param {function} fallback    shell.openPath, injected so this module stays
 *                               free of electron imports
 */
function openInEditor(target, { editor = 'system', customCommand = '' } = {}, fallback) {
  const configured = openWithSetting(target, editor, customCommand);
  if (configured) return configured;
  const reason =
    editor === 'custom'
      ? 'custom command not found'
      : EDITORS[editor]
        ? `${EDITORS[editor].label} not found`
        : undefined;

  if (deps.isDirectory(target)) {
    const app = deps.defaultCodeEditor();
    if (!app) return { ok: false, needsChoice: true, reason };
    spawnDetached('/usr/bin/open', ['-b', app.bundleId, target]);
    return { ok: true, via: app.name, reason };
  }
  return fallbackOpen(target, fallback, reason);
}

// Step 1 of openInEditor: the editor WPXen's settings name, or null when the
// setting is 'system' or names something that isn't installed.
function openWithSetting(target, editor, customCommand) {
  if (editor === 'custom') {
    const cmd = String(customCommand || '').trim();
    // A custom command is user-authored and runs with their privileges — the
    // same trust level as anything they'd type into the app's terminal. It is
    // still passed as argv (never concatenated into a shell string) so a path
    // with spaces or quotes can't split into extra arguments.
    if (!cmd) return null;
    const [bin, ...rest] = cmd.split(/\s+/);
    const resolved = resolveBin(bin);
    if (!resolved) return null;
    spawnDetached(resolved, [...rest, target]);
    return { ok: true, via: 'custom' };
  }

  const entry = EDITORS[editor];
  if (!entry) return null;
  const bin = resolveBin(entry.bin);
  if (bin) {
    spawnDetached(bin, [target]);
    return { ok: true, via: entry.bin };
  }
  if (appExists(entry.app)) {
    spawnDetached('/usr/bin/open', ['-a', entry.app, target]);
    return { ok: true, via: entry.app };
  }
  return null;
}

// File types whose default app says which code editor the user prefers. Not
// .txt (TextEdit) or .sh (often a terminal): those answer a different
// question.
const CODE_PROBE_EXTENSIONS = ['php', 'js', 'ts', 'json', 'css', 'py', 'md'];

// Apps that open code files but are no editor for a folder. A default from
// this list counts as "no default code editor".
const NOT_CODE_EDITORS = new Set([
  'com.apple.TextEdit',
  'com.apple.finder',
  'com.apple.Preview',
  'com.apple.Safari',
  'com.google.Chrome',
  'com.google.chrome',
  'org.mozilla.firefox',
  'com.microsoft.edgemac',
  'com.brave.Browser',
  'company.thebrowser.Browser',
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'dev.warp.Warp-Stable',
  'com.mitchellh.ghostty',
]);

// Asks Launch Services which app opens each probe file (empty files in a
// temp folder, named only by extension) and reads its bundle id and name.
// JXA rather than a UTType lookup: the UniformTypeIdentifiers framework
// can't be imported there, and a file URL needs only AppKit.
const DEFAULT_APP_SCRIPT = `
ObjC.import('AppKit');
function run(argv) {
  const ws = $.NSWorkspace.sharedWorkspace;
  return argv.map((file) => {
    const url = ws.URLForApplicationToOpenURL($.NSURL.fileURLWithPath(file));
    if (url.isNil()) return '';
    const bundle = $.NSBundle.bundleWithURL(url);
    const name = ObjC.unwrap(url.path).split('/').pop().replace(/\\.app$/, '');
    return (bundle.isNil() ? '' : ObjC.unwrap(bundle.bundleIdentifier)) + '\\t' + name;
  }).join('\\n');
}`;

/**
 * The code editor macOS opens source files with, or null when there's none
 * worth opening a folder in. The most common default across the probe types
 * wins, so one odd association (say .md → a Markdown app) doesn't decide it.
 * @returns {{ bundleId: string, name: string } | null}
 */
function defaultCodeEditor() {
  let out = '';
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-editor-probe-'));
    try {
      const files = CODE_PROBE_EXTENSIONS.map((ext) => {
        const file = path.join(dir, `probe.${ext}`);
        fs.writeFileSync(file, '');
        return file;
      });
      out = deps.execFileSync(
        '/usr/bin/osascript',
        ['-l', 'JavaScript', '-e', DEFAULT_APP_SCRIPT, ...files],
        { encoding: 'utf8', timeout: 5000 }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    return null;
  }
  return pickCodeEditor(out);
}

// `bundleId\tname` lines → the most common real editor, or null.
function pickCodeEditor(output) {
  const counts = new Map();
  for (const line of String(output || '').split('\n')) {
    const [bundleId, name] = line.trim().split('\t');
    if (!bundleId || NOT_CODE_EDITORS.has(bundleId)) continue;
    const entry = counts.get(bundleId) || { bundleId, name: name || bundleId, n: 0 };
    entry.n += 1;
    counts.set(bundleId, entry);
  }
  let best = null;
  for (const entry of counts.values()) if (!best || entry.n > best.n) best = entry;
  return best ? { bundleId: best.bundleId, name: best.name } : null;
}

// Builds the AppleScript that opens a new session already cd'd into `dir`.
// The path is escaped for the AppleScript string literal; `quoted form of`
// then shell-escapes it for `cd`, so a path with spaces or quotes can't inject
// commands.
function buildCdScript(app, dir) {
  const escaped = dir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  if (app === 'iterm') {
    return [
      'tell application "iTerm"',
      '  activate',
      '  set newWindow to (create window with default profile)',
      '  tell current session of newWindow',
      `    write text "cd " & quoted form of "${escaped}"`,
      '  end tell',
      'end tell',
    ].join('\n');
  }
  return [
    'tell application "Terminal"',
    '  activate',
    `  do script "cd " & quoted form of "${escaped}"`,
    'end tell',
  ].join('\n');
}

/**
 * Opens a directory in the configured terminal app.
 * Terminal.app and iTerm2 are scripted so the new session starts in `dir`;
 * the others are launched with the directory as their working directory.
 */
function openInTerminal(dir, { terminalApp = 'system' } = {}, fallback) {
  if (typeof dir !== 'string' || /[\n\r\0]/.test(dir)) {
    return { ok: false, error: 'Invalid path' };
  }
  // 'system' keeps the historical behaviour: Terminal.app.
  const choice = terminalApp === 'system' ? 'terminal' : terminalApp;
  const entry = TERMINALS[choice];
  if (!entry) return fallbackOpen(dir, fallback);

  if (choice === 'terminal' || choice === 'iterm') {
    deps.execFile('osascript', ['-e', buildCdScript(choice, dir)], (err) => {
      if (err) fallbackOpen(dir, fallback, `${entry.label} could not be scripted`);
    });
    return { ok: true, via: entry.app };
  }

  if (!appExists(entry.app)) {
    return fallbackOpen(dir, fallback, `${entry.label} not found`);
  }
  spawnDetached('/usr/bin/open', ['-a', entry.app, dir]);
  return { ok: true, via: entry.app };
}

function fallbackOpen(target, fallback, reason) {
  if (typeof fallback === 'function') fallback(target);
  return { ok: true, via: 'system', reason };
}

// Exposed for tests and for callers that want to re-probe after an install.
function clearCache() {
  whichCache.clear();
}

// Test hook: swap the child_process functions (see `deps` above).
function __setDeps(next) {
  Object.assign(deps, next);
}

module.exports = {
  EDITORS,
  TERMINALS,
  listTools,
  openInEditor,
  openInTerminal,
  defaultCodeEditor,
  pickCodeEditor,
  resolveBin,
  clearCache,
  __setDeps,
};
