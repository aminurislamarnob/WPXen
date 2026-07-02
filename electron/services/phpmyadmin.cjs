'use strict';

// Serves phpMyAdmin at http://phpmyadmin.test (resolved to 127.0.0.1 by
// dnsmasq, served by nginx + PHP-FPM). It is auto-configured with the stored
// MySQL credentials using phpMyAdmin's `config` auth so it logs in
// automatically — the quick-action button just opens the right database.

const crypto = require('crypto');
const fs = require('fs');
const brew = require('./brew.cjs');
const mysql = require('./mysql.cjs');
const nginx = require('./nginx.cjs');
const php = require('./php.cjs');

const DOMAIN = 'phpmyadmin.test';

function getInstallDir() {
  const prefix = brew.getBrewPrefix();
  return prefix ? `${prefix}/share/phpmyadmin` : null;
}

function isInstalled() {
  const dir = getInstallDir();
  return !!dir && fs.existsSync(`${dir}/index.php`);
}

// Installs phpMyAdmin via Homebrew if missing. Has a bottle, so it's quick and
// needs no sudo.
function ensureInstalled() {
  if (isInstalled()) return;
  brew.execBrew('install phpmyadmin');
  if (!isInstalled()) {
    throw new Error('Failed to install phpMyAdmin via Homebrew.');
  }
}

// Quotes a value as a PHP single-quoted string literal.
function phpStr(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// Writes config.inc.php pointing at the local MySQL server with the stored
// credentials and auto-login, so no password screen appears.
function writeConfig() {
  const dir = getInstallDir();
  if (!dir) throw new Error('Could not resolve the phpMyAdmin directory.');

  const { user, password } = mysql.getCredentials();
  const socket = mysql.getSocketPath();
  const tmpDir = `${dir}/tmp`;
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const lines = [
    '<?php',
    `$cfg['blowfish_secret'] = ${phpStr(crypto.randomBytes(16).toString('hex'))};`,
    '$i = 0;',
    '$i++;',
    "$cfg['Servers'][$i]['auth_type'] = 'config';",
    "$cfg['Servers'][$i]['host'] = 'localhost';",
    socket ? `$cfg['Servers'][$i]['socket'] = ${phpStr(socket)};` : '',
    `$cfg['Servers'][$i]['user'] = ${phpStr(user)};`,
    `$cfg['Servers'][$i]['password'] = ${phpStr(password)};`,
    "$cfg['Servers'][$i]['AllowNoPassword'] = true;",
    `$cfg['TempDir'] = ${phpStr(tmpDir)};`,
    '',
  ];
  fs.writeFileSync(`${dir}/config.inc.php`, lines.filter((l) => l !== '').join('\n'), 'utf8');
}

// Writes/refreshes the nginx vhost for phpmyadmin.test and reloads nginx.
function ensureVhost() {
  const dir = getInstallDir();
  if (!dir) throw new Error('Could not resolve the phpMyAdmin directory.');

  nginx.createSiteConfig({
    name: 'phpMyAdmin',
    domain: DOMAIN,
    path: dir,
    phpVersion: brew.getActivePhpVersion(),
  });
  try {
    nginx.reload();
  } catch {}
}

// Makes sure the services phpMyAdmin depends on are up.
async function ensureServices() {
  const active = brew.getActivePhpVersion();
  if (active && !php.isPhpFpmRunning(active)) {
    try {
      await php.startPhpFpm(active);
    } catch {}
  }
  if (!nginx.isRunning()) {
    try {
      await nginx.start();
    } catch {}
  }
}

async function ensureReady() {
  ensureInstalled();
  writeConfig();
  ensureVhost();
  await ensureServices();
}

function getUrl(dbName) {
  const base = `http://${DOMAIN}/`;
  if (!dbName) return base;
  return `${base}index.php?route=/database/structure&db=${encodeURIComponent(dbName)}`;
}

module.exports = {
  DOMAIN,
  getInstallDir,
  isInstalled,
  ensureInstalled,
  writeConfig,
  ensureVhost,
  ensureReady,
  getUrl,
};
