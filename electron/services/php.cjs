'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const brew = require('./brew.cjs');
const execAsync = require('./asyncExec.cjs');

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

function switchActivePhpVersion(version) {
  const prefix = brew.getBrewPrefix();
  if (!prefix) throw new Error('Homebrew not found');

  // Unlink current php
  try {
    brew.execBrew('unlink php');
  } catch {}

  // Unlink all php versions
  const versions = brew.getInstalledPhpVersions();
  for (const v of versions) {
    try {
      brew.execBrew(`unlink php@${v}`);
    } catch {}
  }

  // Link new version
  const targetFormula = `php@${version}`;
  const prefix2 = brew.getBrewPrefix();
  if (fs.existsSync(`${prefix2}/opt/${targetFormula}`)) {
    brew.execBrew(`link --overwrite --force ${targetFormula}`);
  } else {
    brew.execBrew('link --overwrite --force php');
  }
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
  switchActivePhpVersion,
  getBrewServiceName,
};
