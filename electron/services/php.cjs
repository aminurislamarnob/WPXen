'use strict';

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const brew = require('./brew.cjs');
const execAsync = require('./asyncExec.cjs');

// PHP versions available as Homebrew core formulae (php@<version>). Newest
// first. Kept in sync with the versions probed by brew.getInstalledPhpVersions.
const KNOWN_PHP_VERSIONS = ['8.4', '8.3', '8.2', '8.1'];

function getPhpBinPath(version) {
  const prefix = brew.getBrewPrefix();
  if (!prefix) return null;
  // Specific version
  const versionedPath = `${prefix}/opt/php@${version}/bin/php`;
  if (fs.existsSync(versionedPath)) return versionedPath;
  // Default (might match active version)
  const defaultPath = `${prefix}/bin/php`;
  if (fs.existsSync(defaultPath)) return defaultPath;
  return null;
}

function getPhpFpmBinPath(version) {
  const prefix = brew.getBrewPrefix();
  if (!prefix) return null;
  const versionedPath = `${prefix}/opt/php@${version}/sbin/php-fpm`;
  if (fs.existsSync(versionedPath)) return versionedPath;
  const defaultPath = `${prefix}/sbin/php-fpm`;
  if (fs.existsSync(defaultPath)) return defaultPath;
  return null;
}

function getBrewServiceName(version) {
  const prefix = brew.getBrewPrefix();
  // Check if versioned formula exists
  if (fs.existsSync(`${prefix}/opt/php@${version}`)) {
    return `php@${version}`;
  }
  return 'php';
}

function isPhpFpmRunning(_version) {
  try {
    const out = execSync(`pgrep -f "php-fpm: master"`, { stdio: 'pipe' })
      .toString()
      .trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

// Non-blocking variant used by the status poller (see asyncExec.cjs).
async function isPhpFpmRunningAsync(_version) {
  try {
    await execAsync(`pgrep -f "php-fpm: master"`, { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

function startPhpFpm(version) {
  const serviceName = getBrewServiceName(version);
  brew.startBrewService(serviceName);
}

function stopPhpFpm(version) {
  const serviceName = getBrewServiceName(version);
  brew.stopBrewService(serviceName);
}

function stopAllPhpFpm() {
  const versions = brew.getInstalledPhpVersions();
  for (const v of versions) {
    try {
      const serviceName = getBrewServiceName(v);
      brew.stopBrewService(serviceName);
    } catch {}
  }
}

function getPhpVersion(version) {
  const phpBin = getPhpBinPath(version);
  if (!phpBin) return null;
  try {
    return execSync(`${phpBin} -r "echo phpversion();"`, { stdio: 'pipe' })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

// Non-blocking variant used by the PHP page (see asyncExec.cjs).
async function getPhpVersionAsync(version) {
  const phpBin = getPhpBinPath(version);
  if (!phpBin) return null;
  try {
    const { stdout } = await execAsync(`${phpBin} -r "echo phpversion();"`, {
      timeout: 4000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function getInstalledPhpVersionsWithDetails() {
  const versions = brew.getInstalledPhpVersions();
  const activeVersion = brew.getActivePhpVersion();

  return versions.map((v) => {
    const fullVersion = getPhpVersion(v);
    const running = isPhpFpmRunning(v);
    return {
      version: v,
      fullVersion: fullVersion || v,
      active: v === activeVersion,
      running,
      socketPath: brew.getPhpFpmSocketPath(v),
    };
  });
}

// Non-blocking variant used by the get-php-versions IPC handler. Probes every
// version's full number and FPM state in parallel so opening the PHP page
// doesn't freeze the main thread.
async function getInstalledPhpVersionsWithDetailsAsync() {
  const versions = brew.getInstalledPhpVersions();
  const [activeVersion, running] = await Promise.all([
    brew.getActivePhpVersionAsync(),
    isPhpFpmRunningAsync(),
  ]);

  const fullVersions = await Promise.all(versions.map((v) => getPhpVersionAsync(v)));

  return versions.map((v, i) => ({
    version: v,
    fullVersion: fullVersions[i] || v,
    active: v === activeVersion,
    // isPhpFpmRunning isn't version-specific (matches any "php-fpm: master"),
    // so the single probe result applies to whichever version is active.
    running,
    socketPath: brew.getPhpFpmSocketPath(v),
  }));
}

// Lists PHP versions WPHerd can install via Homebrew, each flagged with whether
// it's already installed. Any installed version not in the known list (e.g. a
// newer release from a tap) is appended so nothing installed is ever hidden.
function getInstallablePhpVersions() {
  const installed = new Set(brew.getInstalledPhpVersions());
  const versions = [...new Set([...KNOWN_PHP_VERSIONS, ...installed])];
  return versions
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((version) => ({ version, installed: installed.has(version) }));
}

// Installs `php@<version>` via Homebrew, streaming each output line to
// `onProgress`. Resolves on success; rejects with the tail of brew's output on
// failure. brew install needs no sudo (it writes into the Homebrew prefix).
function installPhpVersion(version, onProgress) {
  return new Promise((resolve, reject) => {
    if (!/^\d+\.\d+$/.test(String(version))) {
      reject(new Error('Invalid PHP version'));
      return;
    }
    const brewBin = brew.getBrewPath();
    if (!brewBin) {
      reject(new Error('Homebrew is not installed'));
      return;
    }

    const formula = `php@${version}`;
    const prefix = brew.getBrewPrefix();
    const child = spawn(brewBin, ['install', formula], {
      env: {
        ...process.env,
        PATH: `${prefix}/bin:${process.env.PATH}`,
        // Skip the slow auto-update on every install; keeps output focused.
        HOMEBREW_NO_AUTO_UPDATE: '1',
        HOMEBREW_NO_ENV_HINTS: '1',
      },
    });

    // brew writes most progress to stderr; keep a rolling tail for the error.
    let tail = '';
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
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(tail.trim() || `brew install ${formula} failed (exit ${code})`)
        );
      }
    });
  });
}

function switchActivePhpVersion(version) {
  const prefix = brew.getBrewPrefix();
  if (!prefix) throw new Error('Homebrew not found');

  // Resolve the real formula for this version up front (php@X vs the
  // unversioned php), so we fail cleanly instead of trying to link a
  // non-existent keg via a stale opt symlink.
  const targetFormula = brew.phpFormulaForVersion(version);
  if (!targetFormula) {
    throw new Error(`PHP ${version} is not installed`);
  }

  // Unlink every installed php formula (best-effort) before linking the target.
  try {
    brew.execBrew('unlink php');
  } catch {}
  for (const v of brew.getInstalledPhpVersions()) {
    try {
      brew.execBrew(`unlink php@${v}`);
    } catch {}
  }

  brew.execBrew(`link --overwrite --force ${targetFormula}`);
}

module.exports = {
  getPhpBinPath,
  getPhpFpmBinPath,
  isPhpFpmRunning,
  isPhpFpmRunningAsync,
  startPhpFpm,
  stopPhpFpm,
  stopAllPhpFpm,
  getInstalledPhpVersionsWithDetails,
  getInstalledPhpVersionsWithDetailsAsync,
  getInstallablePhpVersions,
  installPhpVersion,
  switchActivePhpVersion,
  getBrewServiceName,
};
