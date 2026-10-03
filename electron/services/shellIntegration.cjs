'use strict';

// Puts a Site's PHP first on PATH in that Site's terminals.
//
// Setting PATH on the pty isn't enough: Sessions run an interactive login
// shell, which sources the user's startup files *after* our environment —
// and the standard Homebrew line in them, `eval "$(brew shellenv)"`,
// unconditionally puts /opt/homebrew/bin (the globally linked `php`) back in
// front. So for zsh we do what VS Code's shell integration does: point ZDOTDIR
// at a WPXen-owned directory whose startup files each source the user's real
// one, exactly as zsh would have, and only in the last one (.zlogin) put the
// Site's PHP first. Nothing the user's files do can come after that.
//
// Other shells get no wrapper; agents.cjs prefixes the agent's own command
// line instead (POSIX shells only), so the agent still sees the Site's PHP.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Carries the app's name outside its bundle (see CLAUDE.md, "Legacy names").
// Under the temp dir and rewritten on every spawn, so nothing lingers.
const ZSH_DIR_NAME = 'wpxen-zsh';

// Each wrapper file hands zsh to the user's directory to source their file,
// then takes it back so zsh finds our next file. WPXEN_USER_ZDOTDIR is where
// the user's files live (their own ZDOTDIR, or HOME).
function proxyFile(name) {
  return [
    `# WPXen shell integration — runs your ${name}, then hands back to WPXen.`,
    'WPXEN_ZDOTDIR="$ZDOTDIR"',
    'ZDOTDIR="$WPXEN_USER_ZDOTDIR"',
    `[ -f "$ZDOTDIR/${name}" ] && . "$ZDOTDIR/${name}"`,
    'WPXEN_USER_ZDOTDIR="$ZDOTDIR"',
    'ZDOTDIR="$WPXEN_ZDOTDIR"',
    '',
  ].join('\n');
}

// The startup files, by name. Pure, so they're testable as text — and the
// test also runs them in a real zsh. For a login interactive shell zsh reads
// .zshenv, .zprofile, .zshrc, .zlogin in that order; .zlogin is the last.
function zshStartupFiles() {
  return {
    '.zshenv': proxyFile('.zshenv'),
    '.zprofile': proxyFile('.zprofile'),
    '.zshrc': proxyFile('.zshrc'),
    '.zlogin': [
      '# WPXen shell integration — runs your .zlogin, then puts this Site’s PHP',
      '# first on PATH, after every startup file has had its say.',
      'if [ -n "$WPXEN_HAD_ZDOTDIR" ]; then',
      '  ZDOTDIR="$WPXEN_USER_ZDOTDIR"',
      'else',
      '  unset ZDOTDIR',
      'fi',
      '[ -f "${ZDOTDIR:-$HOME}/.zlogin" ] && . "${ZDOTDIR:-$HOME}/.zlogin"',
      'if [ -n "$WPXEN_PHP_BIN" ]; then',
      '  path=("$WPXEN_PHP_BIN" ${path:#$WPXEN_PHP_BIN})',
      '  export PATH',
      'fi',
      'unset WPXEN_ZDOTDIR WPXEN_USER_ZDOTDIR WPXEN_HAD_ZDOTDIR WPXEN_PHP_BIN',
      '',
    ].join('\n'),
  };
}

function writeZshIntegration(baseDir = os.tmpdir()) {
  const dir = path.join(baseDir, ZSH_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(zshStartupFiles())) {
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

function isZsh(shell) {
  return path.basename(String(shell || '')) === 'zsh';
}

// The env a Site terminal spawns with so `phpBinDir` ends up first on PATH.
// For zsh: the wrapper. For anything else: just the PATH prepend, which a
// shell's startup files may undo — agents.cjs covers that by prefixing the
// agent command.
function sitePhpEnv({ env, shell, phpBinDir, baseDir }) {
  if (!phpBinDir) return {};
  const prepended = { PATH: [phpBinDir, env.PATH].filter(Boolean).join(':') };
  if (!isZsh(shell)) return prepended;
  return {
    ...prepended,
    ZDOTDIR: writeZshIntegration(baseDir),
    WPXEN_USER_ZDOTDIR: env.ZDOTDIR || env.HOME || os.homedir(),
    WPXEN_HAD_ZDOTDIR: env.ZDOTDIR ? '1' : '',
    WPXEN_PHP_BIN: phpBinDir,
  };
}

// For shells the wrapper doesn't cover: run the typed agent command with the
// Site's PHP first. POSIX syntax only — anything else is left as typed.
function prefixCommandWithPhp(command, shell, phpBinDir) {
  if (!command || !phpBinDir || isZsh(shell)) return command;
  if (!['bash', 'sh', 'dash', 'ksh'].includes(path.basename(String(shell || '')))) {
    return command;
  }
  if (!/^[\w./@+-]+$/.test(phpBinDir)) return command;
  return `PATH=${phpBinDir}:"$PATH" ${command}`;
}

module.exports = {
  ZSH_DIR_NAME,
  zshStartupFiles,
  writeZshIntegration,
  sitePhpEnv,
  prefixCommandWithPhp,
  isZsh,
};
