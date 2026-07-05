'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
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

// Runs a php binary and returns its major.minor (e.g. "8.3"), or null. Used to
// verify a formula's *actual* version rather than trusting its name — an `opt`
// symlink can be stale (e.g. php@8.4 -> Cellar/php/8.5.7 after an upgrade).
function phpBinaryVersion(phpBin) {
  try {
    const out = execSync(`${phpBin} -r "echo PHP_MAJOR_VERSION.'.'.PHP_MINOR_VERSION;"`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
    return /^\d+\.\d+$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

// Candidate versioned formulae WPHerd knows how to detect/install.
const PHP_VERSION_CANDIDATES = ['8.4', '8.3', '8.2', '8.1', '8.0', '7.4'];

function getInstalledPhpVersions() {
  const prefix = getBrewPrefix();
  if (!prefix) return [];

  const versions = new Set();

  // Unversioned `php` formula — record whatever major.minor it actually is
  // (the "latest" formula tracks the newest release, e.g. 8.5). Probe its
  // canonical opt path, not ${prefix}/bin/php, so it's still detected when
  // currently unlinked because another version is active.
  const defaultOpt = `${prefix}/opt/php/bin/php`;
  if (fs.existsSync(defaultOpt)) {
    const v = phpBinaryVersion(defaultOpt);
    if (v) versions.add(v);
  }

  // Versioned php@X formulae. Trust the binary's reported version, not the
  // formula name, so a stale opt symlink pointing at a different keg (e.g.
  // php@8.4 -> php 8.5) isn't counted as that version.
  for (const v of PHP_VERSION_CANDIDATES) {
    const phpBin = `${prefix}/opt/php@${v}/bin/php`;
    if (fs.existsSync(phpBin) && phpBinaryVersion(phpBin) === v) {
      versions.add(v);
    }
  }

  return [...versions].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

// Resolves the Homebrew formula that actually provides `version`, or null if it
// isn't installed. Prefers a real versioned keg (Cellar/php@X); otherwise falls
// back to the unversioned `php` when it currently reports that version.
function phpFormulaForVersion(version) {
  const prefix = getBrewPrefix();
  if (!prefix) return null;

  if (fs.existsSync(`${prefix}/Cellar/php@${version}`)) {
    return `php@${version}`;
  }

  const defaultOpt = `${prefix}/opt/php/bin/php`;
  if (fs.existsSync(defaultOpt) && phpBinaryVersion(defaultOpt) === version) {
    return 'php';
  }

  return null;
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

// Returns the set of outdated formula names (both short and fully-qualified,
// e.g. "php@8.3" and "shivammathur/php/php@8.3") so callers can check whether an
// installed formula has an update available. Best-effort — resolves to an empty
// set on any error.
async function getOutdatedFormulae() {
  try {
    const { stdout } = await execBrewAsync('outdated --json=v2');
    const data = JSON.parse(stdout);
    const names = new Set();
    for (const f of data.formulae || []) {
      if (f.name) names.add(f.name);
      if (f.full_name) names.add(f.full_name);
    }
    return names;
  } catch {
    return new Set();
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
  const { adminOsascript } = require('./admin.cjs');
  const prefix = getBrewPrefix();
  const shellCmd = `PATH=${prefix}/bin:$PATH ${brewBin} services ${action} ${name}`;
  const reason = `WPHerd wants to ${action} the ${name} service.`;
  execSync(adminOsascript(shellCmd, reason), {
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
  tryWhich,
  execBrew,
  isPackageInstalled,
  isPackageInstalledAsync,
  getInstalledPhpVersions,
  phpFormulaForVersion,
  getOutdatedFormulae,
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
