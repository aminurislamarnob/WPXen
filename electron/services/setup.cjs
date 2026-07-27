'use strict';

// First-run setup helpers for the onboarding wizard. Automates the parts of
// the fresh-Mac bootstrap that CAN run in-app — batch-installing the core
// Homebrew formulae — and hands off the one part that can't (installing
// Homebrew itself) to Terminal.app.
//
// Homebrew is NOT installable from inside the app: its installer refuses to
// run as root (so it can't go through `adminOsascript`) and its internal sudo
// calls need an interactive TTY that a spawned Electron child doesn't have. It
// also auto-triggers the Xcode Command Line Tools install. So we open Terminal
// preloaded with the official one-liner and let the existing focus-based deps
// re-check (ipc.cjs `win.on('focus')` → `dependencies-update`) notice when it
// finishes.

const { execFile } = require('child_process');
const brew = require('./brew.cjs');
const php = require('./php.cjs');

// Homebrew formula names WPDevPilot needs. Note the formula is `wp-cli` while the
// dependency key `checkAllDependencies` reports is `wpCli`. Plain `php` = the
// latest release, which matches the generic `php` dep check and avoids the
// shivammathur tap-trust flow used only for EOL versions.
const CORE_FORMULAE = ['nginx', 'php', 'mysql', 'dnsmasq', 'wp-cli'];

// The official Homebrew install command. Shown as a copy-able fallback in the
// wizard and run in Terminal by openHomebrewInstaller().
const HOMEBREW_INSTALL_CMD =
  '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';

// Installs whichever core formulae are missing in a single streamed
// `brew install`. Idempotent — already-installed formulae are skipped, so a
// re-run after a partial failure only installs the remainder. No sudo (brew
// writes into its own prefix).
async function installCoreDeps(onProgress) {
  const checks = await Promise.all(
    CORE_FORMULAE.map((f) => brew.isPackageInstalledAsync(f).catch(() => false))
  );
  const missing = CORE_FORMULAE.filter((_, i) => !checks[i]);

  if (missing.length === 0) {
    if (onProgress) onProgress('All core services already installed.');
    return { installed: [] };
  }

  await php.runBrewStreaming(['install', ...missing], onProgress);
  brew.invalidateDependencyCache();
  return { installed: missing };
}

// Opens Terminal.app running the official Homebrew installer. Escaping mirrors
// the `open-in-terminal` IPC handler: escape backslashes/quotes for the
// AppleScript string literal.
function openHomebrewInstaller() {
  const escaped = HOMEBREW_INSTALL_CMD.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = [
    'tell application "Terminal"',
    '  activate',
    `  do script "${escaped}"`,
    'end tell',
  ].join('\n');
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

module.exports = {
  CORE_FORMULAE,
  HOMEBREW_INSTALL_CMD,
  installCoreDeps,
  openHomebrewInstaller,
};
