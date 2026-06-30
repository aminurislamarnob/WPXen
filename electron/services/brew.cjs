'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const execAsync = require('./asyncExec.cjs');

// Detect Homebrew prefix (Apple Silicon vs Intel)
function getBrewPrefix() {
  if (fs.existsSync('/opt/homebrew/bin/brew')) return '/opt/homebrew';
  if (fs.existsSync('/usr/local/bin/brew')) return '/usr/local';
  return null;
}

function getBrewPath() {
  const prefix = getBrewPrefix();
  return prefix ? `${prefix}/bin/brew` : null;
}

function isBrewInstalled() {
  return getBrewPath() !== null;
}

function execBrew(command) {
  const brew = getBrewPath();
  if (!brew) throw new Error('Homebrew is not installed');
  return execSync(`${brew} ${command}`, {
    env: { ...process.env, PATH: `${getBrewPrefix()}/bin:${process.env.PATH}` },
    // Capture stderr into the thrown error instead of leaking it to the
    // console (e.g. "No such keg" when probing for an uninstalled formula).
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
}

function isPackageInstalled(name) {
  try {
    execBrew(`list --formula ${name}`);
    return true;
  } catch {
    return false;
  }
}

// Non-blocking `brew` runner for the dependency check (see asyncExec.cjs).
// `brew list` spawns Ruby and can take 1-3s — synchronous calls freeze the UI.
function execBrewAsync(command) {
  const brewBin = getBrewPath();
  if (!brewBin) return Promise.reject(new Error('Homebrew is not installed'));
  return execAsync(`${brewBin} ${command}`, {
    env: { ...process.env, PATH: `${getBrewPrefix()}/bin:${process.env.PATH}` },
    timeout: 8000,
  });
}

async function isPackageInstalledAsync(name) {
  try {
    await execBrewAsync(`list --formula ${name}`);
    return true;
  } catch {
    return false;
  }
}

function getInstalledPhpVersions() {
  const prefix = getBrewPrefix();
  if (!prefix) return [];

  const versions = [];

  // Check for default php
  if (fs.existsSync(`${prefix}/bin/php`)) {
    try {
      const out = execSync(`${prefix}/bin/php -r "echo PHP_MAJOR_VERSION.'.'.PHP_MINOR_VERSION;"`)
        .toString()
        .trim();
      if (out.match(/^\d+\.\d+$/)) {
        versions.push(out);
      }
    } catch {}
  }

  // Check for versioned php formulae
  const phpVersions = ['8.4', '8.3', '8.2', '8.1', '8.0', '7.4'];
  for (const v of phpVersions) {
    const phpBin = `${prefix}/opt/php@${v}/bin/php`;
    if (fs.existsSync(phpBin)) {
      if (!versions.includes(v)) versions.push(v);
    }
  }

  return [...new Set(versions)].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

function getActivePhpVersion() {
  const prefix = getBrewPrefix();
  if (!prefix) return null;
  try {
    const phpBin = `${prefix}/bin/php`;
    if (!fs.existsSync(phpBin)) return null;
    const out = execSync(`${phpBin} -r "echo PHP_MAJOR_VERSION.'.'.PHP_MINOR_VERSION;"`)
      .toString()
      .trim();
    return out.match(/^\d+\.\d+$/) ? out : null;
  } catch {
    return null;
  }
}

// Non-blocking variant used by the status poller (see asyncExec.cjs).
async function getActivePhpVersionAsync() {
  const prefix = getBrewPrefix();
  if (!prefix) return null;
  const phpBin = `${prefix}/bin/php`;
  if (!fs.existsSync(phpBin)) return null;
  try {
    const { stdout } = await execAsync(
      `${phpBin} -r "echo PHP_MAJOR_VERSION.'.'.PHP_MINOR_VERSION;"`,
      { timeout: 4000 }
    );
    const out = stdout.trim();
    return out.match(/^\d+\.\d+$/) ? out : null;
  } catch {
    return null;
  }
}

function getPhpFpmSocketPath(version) {
  const prefix = getBrewPrefix();
  if (!prefix) return null;
  // Homebrew PHP-FPM sockets
  const candidates = [
    `${prefix}/var/run/php/php${version}-fpm.sock`,
    `/tmp/php${version}-fpm.sock`,
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Return the expected path even if not running yet
  return `${prefix}/var/run/php/php${version}-fpm.sock`;
}

function isNginxInstalled() {
  return isPackageInstalled('nginx');
}

function isMysqlInstalled() {
  return isPackageInstalled('mysql') || isPackageInstalled('mariadb');
}

function isDnsmasqInstalled() {
  return isPackageInstalled('dnsmasq');
}

function isWpCliInstalled() {
  const prefix = getBrewPrefix();
  if (!prefix) return false;
  return fs.existsSync(`${prefix}/bin/wp`) || !!tryWhich('wp');
}

function tryWhich(cmd) {
  try {
    return execSync(`which ${cmd}`).toString().trim();
  } catch {
    return null;
  }
}

function checkAllDependencies() {
  const brew = isBrewInstalled();
  return {
    brew,
    nginx: brew && isNginxInstalled(),
    php: brew && getInstalledPhpVersions().length > 0,
    mysql: brew && isMysqlInstalled(),
    dnsmasq: brew && isDnsmasqInstalled(),
    wpCli: isWpCliInstalled(),
  };
}

// Installed packages don't change during a session, so the result is cached
// after the first probe. Pass force=true to re-check (e.g. after the user
// installs something). Runs the slow `brew list` calls in parallel and off the
// main thread so navigating to Settings no longer freezes the UI.
let depsCache = null;

async function checkAllDependenciesAsync(force = false) {
  if (depsCache && !force) return depsCache;

  const brewOk = isBrewInstalled();
  if (!brewOk) {
    depsCache = {
      brew: false,
      nginx: false,
      php: false,
      mysql: false,
      dnsmasq: false,
      wpCli: isWpCliInstalled(),
    };
    return depsCache;
  }

  const [nginxOk, mysqlOk, mariadbOk, dnsmasqOk] = await Promise.all([
    isPackageInstalledAsync('nginx'),
    isPackageInstalledAsync('mysql'),
    isPackageInstalledAsync('mariadb'),
    isPackageInstalledAsync('dnsmasq'),
  ]);

  depsCache = {
    brew: true,
    nginx: nginxOk,
    php: getInstalledPhpVersions().length > 0,
    mysql: mysqlOk || mariadbOk,
    dnsmasq: dnsmasqOk,
    wpCli: isWpCliInstalled(),
  };
  return depsCache;
}

function invalidateDependencyCache() {
  depsCache = null;
}

function getBrewServiceStatus(name) {
  try {
    const out = execBrew(`services info ${name} --json`);
    const info = JSON.parse(out);
    if (Array.isArray(info) && info.length > 0) {
      return info[0].status === 'started' ? 'running' : 'stopped';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function startBrewService(name) {
  execBrew(`services start ${name}`);
}

function stopBrewService(name) {
  execBrew(`services stop ${name}`);
}

function restartBrewService(name) {
  execBrew(`services restart ${name}`);
}

// Runs `brew services <action> <name>` as root.
//
// If the WPHerd sudoers file is installed (/etc/sudoers.d/wpherd), sudo runs
// silently with no password prompt. Otherwise falls back to an osascript
// admin-privileges dialog — acceptable for the first run before setup.
function execBrewServiceSudo(action, name) {
  const brewBin = getBrewPath();
  if (!brewBin) throw new Error('Homebrew is not installed');

  // Lazy-require to avoid a circular dependency at module load time.
  const sudoers = require('./sudoers.cjs');

  if (sudoers.isConfigured()) {
    try {
      // Passwordless path — `sudo -n` never prompts. If the NOPASSWD rule
      // doesn't match (stale file, moved brew binary), it fails fast instead
      // of hanging on a non-existent TTY, and we fall through to the dialog.
      execSync(`sudo -n ${brewBin} services ${action} ${name}`, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return;
    } catch {
      // Fall back to the prompting path below.
    }
  }

  // Sudoers not set up (or no longer valid) — prompt via osascript.
  const prefix = getBrewPrefix();
  const shellCmd = `PATH=${prefix}/bin:$PATH ${brewBin} services ${action} ${name}`;
  const appleScript = `do shell script "${shellCmd.replace(/"/g, '\\"')}" with administrator privileges`;
  execSync(`osascript -e '${appleScript.replace(/'/g, "'\\''")}'`, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function startBrewServiceSudo(name) {
  execBrewServiceSudo('start', name);
}

function stopBrewServiceSudo(name) {
  execBrewServiceSudo('stop', name);
}

function restartBrewServiceSudo(name) {
  execBrewServiceSudo('restart', name);
}

module.exports = {
  getBrewPrefix,
  getBrewPath,
  isBrewInstalled,
  execBrew,
  isPackageInstalled,
  isPackageInstalledAsync,
  getInstalledPhpVersions,
  getActivePhpVersion,
  getActivePhpVersionAsync,
  getPhpFpmSocketPath,
  isNginxInstalled,
  isMysqlInstalled,
  isDnsmasqInstalled,
  isWpCliInstalled,
  checkAllDependencies,
  checkAllDependenciesAsync,
  invalidateDependencyCache,
  getBrewServiceStatus,
  startBrewService,
  stopBrewService,
  restartBrewService,
  startBrewServiceSudo,
  stopBrewServiceSudo,
  restartBrewServiceSudo,
};
