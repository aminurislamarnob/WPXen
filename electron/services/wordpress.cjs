'use strict';

const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const brew = require('./brew.cjs');
const mysql = require('./mysql.cjs');
const nginx = require('./nginx.cjs');

const DEFAULT_SITES_DIR = path.join(os.homedir(), 'Sites');

function getSitesDir() {
  return DEFAULT_SITES_DIR;
}

function ensureSitesDir(dir = DEFAULT_SITES_DIR) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getWpCliBin() {
  const prefix = brew.getBrewPrefix();
  const candidates = [
    prefix ? `${prefix}/bin/wp` : null,
    '/usr/local/bin/wp',
    path.join(os.homedir(), '.composer/vendor/bin/wp'),
  ].filter(Boolean);

  const fsCandidates = candidates.filter((c) => fs.existsSync(c));
  if (fsCandidates.length > 0) return fsCandidates[0];

  try {
    return execSync('which wp').toString().trim();
  } catch {
    return null;
  }
}

function wp(args, cwd, extraEnv = {}) {
  const wpBin = getWpCliBin();
  if (!wpBin) throw new Error('WP-CLI not found. Install with: brew install wp-cli');
  const prefix = brew.getBrewPrefix();
  const phpBin = prefix ? `${prefix}/bin/php` : 'php';

  const env = {
    ...process.env,
    PATH: `${prefix}/bin:${process.env.PATH}`,
    HOME: os.homedir(),
    ...extraEnv,
  };

  return execSync(`${phpBin} ${wpBin} ${args} --allow-root`, {
    cwd,
    env,
    stdio: 'pipe',
    timeout: 120000,
  })
    .toString()
    .trim();
}

async function createWordPressSite(siteData, progressCallback) {
  const {
    name,
    domain,
    path: sitePath,
    phpVersion,
    dbName,
    adminUser = 'admin',
    adminPassword = 'admin123',
    adminEmail,
    title,
  } = siteData;

  const progress = progressCallback || (() => {});

  // 1. Create site directory
  progress({ step: 'directory', message: 'Creating site directory...' });
  fs.mkdirSync(sitePath, { recursive: true });

  // 2. Download WordPress core
  progress({ step: 'download', message: 'Downloading WordPress...' });
  wp('core download --skip-content', sitePath);

  // 3. Create database
  progress({ step: 'database', message: 'Creating database...' });
  mysql.createDatabase(dbName);

  // 4. Create wp-config.php
  progress({ step: 'config', message: 'Configuring WordPress...' });
  wp(
    `config create --dbname="${dbName}" --dbuser=root --dbpass="" --dbhost=127.0.0.1 --force`,
    sitePath
  );

  // 5. Install WordPress
  progress({ step: 'install', message: 'Installing WordPress...' });
  wp(
    `core install --url="http://${domain}" --title="${title || name}" --admin_user="${adminUser}" --admin_password="${adminPassword}" --admin_email="${adminEmail || `admin@${domain}`}" --skip-email`,
    sitePath
  );

  // 6. Create nginx config
  progress({ step: 'nginx', message: 'Configuring nginx...' });
  nginx.createSiteConfig({ name, domain, path: sitePath, phpVersion });

  // 7. Reload nginx
  progress({ step: 'reload', message: 'Reloading nginx...' });
  try {
    nginx.reload();
  } catch {
    // nginx might not be running yet
  }

  progress({ step: 'done', message: 'WordPress site ready!' });

  // Get WordPress version
  let wpVersion = 'unknown';
  try {
    wpVersion = wp('core version', sitePath);
  } catch {}

  return {
    id: generateId(),
    name,
    domain,
    path: sitePath,
    phpVersion,
    dbName,
    adminUser,
    adminEmail: adminEmail || `admin@${domain}`,
    wpVersion,
    url: `http://${domain}`,
    createdAt: new Date().toISOString(),
  };
}

function removeWordPressSite(site, opts = {}) {
  // Remove nginx config
  nginx.removeSiteConfig(site.domain);

  // Drop database
  if (opts.removeDatabase !== false) {
    try {
      mysql.dropDatabase(site.dbName);
    } catch {}
  }

  // Remove files
  if (opts.removeFiles && fs.existsSync(site.path)) {
    fs.rmSync(site.path, { recursive: true, force: true });
  }

  // Reload nginx
  try {
    nginx.reload();
  } catch {}
}

function getSiteWordPressVersion(sitePath) {
  try {
    return wp('core version', sitePath);
  } catch {
    return null;
  }
}

function getWordPressInfo(sitePath) {
  if (!fs.existsSync(path.join(sitePath, 'wp-config.php'))) {
    return null;
  }
  try {
    const version = wp('core version', sitePath);
    const siteUrl = wp('option get siteurl', sitePath);
    return { version, siteUrl };
  } catch {
    return null;
  }
}

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function sanitizeDomain(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function sanitizeDbName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

module.exports = {
  DEFAULT_SITES_DIR,
  getSitesDir,
  ensureSitesDir,
  getWpCliBin,
  createWordPressSite,
  removeWordPressSite,
  getSiteWordPressVersion,
  getWordPressInfo,
  sanitizeDomain,
  sanitizeDbName,
  generateId,
};
