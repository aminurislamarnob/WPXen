'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const brew = require('./brew.cjs');
const php = require('./php.cjs');

// Xdebug management. We install the extension from the shivammathur/extensions
// tap (prebuilt bottles for every supported PHP version, including the EOL
// 7.4/8.0 from the shivammathur/php tap) rather than pecl, which would compile
// from source and mutate the global php.ini.
//
// The formula drops its own `zend_extension` ini that actually LOADS Xdebug —
// we never touch that. Instead we own a separate conf.d file that sorts AFTER
// it (zz-wpherd-xdebug.ini) and only sets xdebug.mode etc. Disabling Xdebug is
// `xdebug.mode = off`: the extension stays loaded but inert (near-zero
// overhead), so we never have to unlink the formula's file.

const XDEBUG_TAP = 'shivammathur/extensions';
const CLIENT_PORT = 9003;

// Modes Xdebug understands. WPHerd surfaces the common three (debug, develop,
// and both) but tolerates any comma-list of these tokens.
const VALID_MODE_TOKENS = [
  'debug',
  'develop',
  'coverage',
  'profile',
  'trace',
  'gcstats',
];

// Normalizes a mode string to a deduped, whitelisted comma-list, defaulting to
// 'debug'. Pure — covered by vitest.
function normalizeMode(mode) {
  const tokens = String(mode || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => VALID_MODE_TOKENS.includes(t));
  return tokens.length ? [...new Set(tokens)].join(',') : 'debug';
}

// Renders the managed ini for a desired state. The chosen mode is preserved in
// a `; wpherd:` marker even when disabled, so toggling back on restores it.
// Pure — covered by vitest.
function renderXdebugIni({ enabled, mode = 'debug' } = {}) {
  const chosenMode = normalizeMode(mode);
  const effectiveMode = enabled ? chosenMode : 'off';
  const lines = [
    '; Managed by WPHerd — edit Xdebug from the app.',
    `; wpherd:enabled=${enabled ? 1 : 0}`,
    `; wpherd:mode=${chosenMode}`,
    '',
    `xdebug.mode = ${effectiveMode}`,
  ];
  if (enabled) {
    lines.push('xdebug.start_with_request = yes');
    lines.push('xdebug.client_host = localhost');
    lines.push(`xdebug.client_port = ${CLIENT_PORT}`);
  }
  lines.push('');
  return lines.join('\n');
}

// Reads {enabled, mode} back out of a managed ini's markers. Pure — covered by
// vitest.
function parseXdebugIni(content) {
  const en = String(content || '').match(/^; wpherd:enabled=(\d)/m);
  const md = String(content || '').match(/^; wpherd:mode=([a-z,]+)/m);
  return {
    enabled: en ? en[1] === '1' : false,
    mode: md ? normalizeMode(md[1]) : 'debug',
  };
}

function getXdebugIniPath(version) {
  const prefix = brew.getBrewPrefix();
  if (!prefix) return null;
  return `${prefix}/etc/php/${version}/conf.d/zz-wpherd-xdebug.ini`;
}

function writeXdebugIni(version, state) {
  const p = getXdebugIniPath(version);
  if (!p) throw new Error('Could not resolve the PHP config directory.');
  const dir = p.slice(0, p.lastIndexOf('/'));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, renderXdebugIni(state), 'utf8');
}

// Whether the Xdebug extension is actually loaded by this version's PHP.
function isXdebugInstalled(version) {
  const phpBin = php.getPhpBinPath(version);
  if (!phpBin) return false;
  try {
    const out = execFileSync(phpBin, ['-m'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    return /^xdebug$/im.test(out);
  } catch {
    return false;
  }
}

// Combined status for one version: installed?, and the desired enabled/mode
// from our managed ini (defaults when the file doesn't exist yet).
function getXdebugState(version) {
  const p = getXdebugIniPath(version);
  let markers = { enabled: false, mode: 'debug' };
  try {
    if (p && fs.existsSync(p)) {
      markers = parseXdebugIni(fs.readFileSync(p, 'utf8'));
    }
  } catch {}
  return {
    version,
    installed: isXdebugInstalled(version),
    enabled: markers.enabled,
    mode: markers.mode,
    clientPort: CLIENT_PORT,
  };
}

function getAllXdebugStates() {
  return brew.getInstalledPhpVersions().map((v) => getXdebugState(v));
}

async function ensureXdebugTapTrusted(onProgress) {
  await php.runBrewStreaming(['tap', XDEBUG_TAP], onProgress).catch(() => {});
  await php.runBrewStreaming(['trust', XDEBUG_TAP], onProgress).catch(() => {});
}

// Installs Xdebug for a version via Homebrew, then writes our managed ini
// enabled (mode=debug) so a breakpoint works immediately after install.
async function installXdebug(version, onProgress) {
  if (!/^\d+\.\d+$/.test(String(version))) {
    throw new Error('Invalid PHP version');
  }
  if (!brew.getInstalledPhpVersions().includes(version)) {
    throw new Error(`PHP ${version} is not installed`);
  }
  await ensureXdebugTapTrusted(onProgress);
  await php.runBrewStreaming(
    ['install', `${XDEBUG_TAP}/xdebug@${version}`],
    onProgress
  );
  writeXdebugIni(version, { enabled: true, mode: 'debug' });
  php.reloadPhpFpmIfRunning(version);
  return { installed: true };
}

// Toggles Xdebug and/or its mode for a version, reloading FPM if it's the
// running one.
function setXdebug(version, { enabled, mode } = {}) {
  if (!/^\d+\.\d+$/.test(String(version))) {
    throw new Error('Invalid PHP version');
  }
  if (!isXdebugInstalled(version)) {
    throw new Error(`Xdebug is not installed for PHP ${version}.`);
  }
  // Preserve the currently-stored mode when the caller only flips enabled.
  const current = getXdebugState(version);
  writeXdebugIni(version, {
    enabled: !!enabled,
    mode: mode != null ? mode : current.mode,
  });
  php.reloadPhpFpmIfRunning(version);
  return getXdebugState(version);
}

module.exports = {
  CLIENT_PORT,
  normalizeMode,
  renderXdebugIni,
  parseXdebugIni,
  getXdebugIniPath,
  isXdebugInstalled,
  getXdebugState,
  getAllXdebugStates,
  installXdebug,
  setXdebug,
};
