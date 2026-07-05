'use strict';

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const brew = require('./brew.cjs');
const php = require('./php.cjs');

// Composer and Node tooling. Composer is a single global PHAR (installed via
// Homebrew), run per-site against that site's PHP binary. Node is *not*
// installed by WPHerd — nvm is a shell function, not a binary, so we can't
// `nvm use`; instead we discover the node versions nvm/fnm/brew already dropped
// on disk and let a site pin one, resolving its absolute bin dir when WPHerd
// launches a terminal for the site.

// ─── Composer ────────────────────────────────────────────────────────────

// Parses a `composer --version` line into a bare version string. Pure.
function parseComposerVersion(out) {
  const m = String(out || '').match(/Composer(?:\s+version)?\s+(\d+\.\d+\.\d+[^\s]*)/i);
  return m ? m[1] : null;
}

function getComposerStatus() {
  const bin = brew.tryWhich('composer');
  if (!bin) return { installed: false };
  try {
    const out = execFileSync(bin, ['--version', '--no-interaction'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    return { installed: true, path: bin, version: parseComposerVersion(out) };
  } catch {
    return { installed: true, path: bin, version: null };
  }
}

function installComposer(onProgress) {
  return php.runBrewStreaming(['install', 'composer'], onProgress);
}

// Composer subcommands WPHerd exposes. Anything else is rejected so a tampered
// store or renderer can't drive arbitrary composer (and thus arbitrary script)
// execution. Returns the sanitized argv. Pure.
const ALLOWED_COMPOSER = ['install', 'update', 'dump-autoload', 'clear-cache'];
function sanitizeComposerArgs(args) {
  const list = Array.isArray(args) ? args : [args];
  const cmd = String(list[0] || '').trim();
  if (!ALLOWED_COMPOSER.includes(cmd)) {
    throw new Error(`Composer command not allowed: ${cmd || '(none)'}`);
  }
  return [cmd, '--no-interaction'];
}

// Runs a whitelisted composer command in a site's directory with that site's
// PHP on PATH, streaming output line-by-line. Rejects on non-zero exit.
function runComposer(site, args, onProgress) {
  return new Promise((resolve, reject) => {
    const composerBin = brew.tryWhich('composer');
    if (!composerBin) {
      reject(new Error('Composer is not installed.'));
      return;
    }
    if (!site || !site.path || !fs.existsSync(site.path)) {
      reject(new Error('Site directory not found.'));
      return;
    }
    let safe;
    try {
      safe = sanitizeComposerArgs(args);
    } catch (err) {
      reject(err);
      return;
    }

    const phpBin = php.getPhpBinPath(site.phpVersion);
    const env = { ...process.env, COMPOSER_NO_INTERACTION: '1' };
    if (phpBin) env.PATH = `${path.dirname(phpBin)}:${env.PATH}`;

    const child = spawn(composerBin, safe, { cwd: site.path, env });
    let tail = '';
    const emit = (buf) => {
      const text = buf.toString();
      tail = (tail + text).slice(-4000);
      for (const line of text.split('\n')) {
        const trimmed = line.replace(/\s+$/, '');
        if (trimmed && typeof onProgress === 'function') onProgress(trimmed);
      }
    };
    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(tail.trim() || `composer ${safe.join(' ')} failed (exit ${code})`));
    });
  });
}

// ─── Node (per-site version) ───────────────────────────────────────────────

// Descending semver comparator for "X.Y.Z" strings. Pure.
function compareSemverDesc(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
  }
  return 0;
}

// From a list of directory names (e.g. nvm's `v20.11.0`), returns the valid
// bare semver strings, newest first. Pure.
function parseNodeVersionDirs(entries) {
  return (entries || [])
    .map((e) => String(e))
    .filter((e) => /^v\d+\.\d+\.\d+$/.test(e))
    .map((e) => e.slice(1))
    .sort(compareSemverDesc);
}

function pushVersion(list, version, bin, source) {
  if (fs.existsSync(path.join(bin, 'node')) && !list.some((v) => v.version === version)) {
    list.push({ version, bin, source });
  }
}

// Discovers node installs on disk from nvm, fnm, and a brew/system node —
// without sourcing any shell. Newest first.
function getNodeVersions() {
  const versions = [];
  const home = os.homedir();

  // nvm: ~/.nvm/versions/node/v<ver>/bin/node
  try {
    const nvmBase = path.join(home, '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmBase)) {
      for (const v of parseNodeVersionDirs(fs.readdirSync(nvmBase))) {
        pushVersion(versions, v, path.join(nvmBase, `v${v}`, 'bin'), 'nvm');
      }
    }
  } catch {}

  // fnm: ~/.local/share/fnm/node-versions/v<ver>/installation/bin/node (or ~/.fnm)
  try {
    for (const base of [
      path.join(home, '.local', 'share', 'fnm', 'node-versions'),
      path.join(home, '.fnm', 'node-versions'),
    ]) {
      if (fs.existsSync(base)) {
        for (const v of parseNodeVersionDirs(fs.readdirSync(base))) {
          pushVersion(versions, v, path.join(base, `v${v}`, 'installation', 'bin'), 'fnm');
        }
      }
    }
  } catch {}

  // brew / system node on PATH
  try {
    const sys = brew.tryWhich('node');
    if (sys) {
      const out = execFileSync(sys, ['--version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      const m = out.match(/v?(\d+\.\d+\.\d+)/);
      if (m) pushVersion(versions, m[1], path.dirname(sys), 'system');
    }
  } catch {}

  versions.sort((a, b) => compareSemverDesc(a.version, b.version));
  return { versions };
}

// Resolves a version string to its absolute bin dir, or null. Accepts "20.11.0"
// or "v20.11.0".
function resolveNodeBinDir(version) {
  if (!version) return null;
  const want = String(version).replace(/^v/, '');
  const found = getNodeVersions().versions.find((v) => v.version === want);
  return found ? found.bin : null;
}

module.exports = {
  ALLOWED_COMPOSER,
  parseComposerVersion,
  sanitizeComposerArgs,
  getComposerStatus,
  installComposer,
  runComposer,
  compareSemverDesc,
  parseNodeVersionDirs,
  getNodeVersions,
  resolveNodeBinDir,
};
