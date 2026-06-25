'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

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

module.exports = {
  getBrewPrefix,
  getBrewPath,
  isBrewInstalled,
  execBrew,
  isPackageInstalled,
  getInstalledPhpVersions,
  getActivePhpVersion,
  getPhpFpmSocketPath,
  isNginxInstalled,
  isMysqlInstalled,
  isDnsmasqInstalled,
  isWpCliInstalled,
  checkAllDependencies,
  getBrewServiceStatus,
  startBrewService,
  stopBrewService,
  restartBrewService,
};
