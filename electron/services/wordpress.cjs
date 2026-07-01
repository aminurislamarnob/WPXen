'use strict';

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const brew = require('./brew.cjs');
const mysql = require('./mysql.cjs');
const nginx = require('./nginx.cjs');
const { validateSiteInput } = require('./validation.cjs');

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

// Runs WP-CLI. `args` is an ARRAY of arguments — passed via execFileSync with
// no shell, so values like the site title or admin password can't be
// interpreted as shell metacharacters (command injection). Never build this
// from a concatenated string.
function wp(args, cwd, extraEnv = {}) {
  if (!Array.isArray(args)) {
    throw new TypeError('wp() requires an array of arguments');
  }
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

  // Newer PHP (8.4/8.5) makes WP-CLI's bundled deps emit deprecation notices.
  // Route all PHP diagnostics to stderr and silence deprecations so they never
  // contaminate the captured stdout (e.g. `wp core version`).
  const phpArgs = [
    '-d',
    'error_reporting=E_ALL & ~E_DEPRECATED & ~E_STRICT',
    '-d',
    'display_errors=stderr',
  ];

  return execFileSync(phpBin, [...phpArgs, wpBin, ...args, '--allow-root'], {
    cwd,
    env,
    stdio: 'pipe',
    timeout: 120000,
  })
    .toString()
    .trim();
}

// WP-CLI output should be a bare version like "6.8.2". Guard against any stray
// warning text sneaking in by keeping only a version-shaped token.
function sanitizeWpVersion(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^\d+\.\d+(?:\.\d+)*$/) ? raw.trim() : null;
  return m;
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

  // Validate before touching the filesystem, DB, or shelling out. This is the
  // authoritative check (the renderer's form validation is advisory only).
  const { valid, errors } = validateSiteInput(siteData);
  if (!valid) {
    throw new Error(errors.join(' '));
  }

  // 1. Create site directory
  progress({ step: 'directory', message: 'Creating site directory...' });
  fs.mkdirSync(sitePath, { recursive: true });

  // 2. Download WordPress core (with bundled default themes/plugins — no
  // --skip-content, so the Twenty* themes ship with the install).
  progress({ step: 'download', message: 'Downloading WordPress...' });
  wp(['core', 'download'], sitePath);

  // 3. Create database
  progress({ step: 'database', message: 'Creating database...' });
  mysql.createDatabase(dbName);

  // 4. Create wp-config.php
  progress({ step: 'config', message: 'Configuring WordPress...' });
  const { user: dbUser, password: dbPass } = mysql.getCredentials();
  // Use 'localhost' so PHP connects over the same socket the CLI used,
  // matching the credentials' host grant (e.g. 'root'@'localhost').
  // Each array element is a single argv token — no shell, no injection.
  wp(
    [
      'config',
      'create',
      `--dbname=${dbName}`,
      `--dbuser=${dbUser}`,
      `--dbpass=${dbPass}`,
      '--dbhost=localhost',
      '--force',
    ],
    sitePath
  );

  // 5. Install WordPress
  progress({ step: 'install', message: 'Installing WordPress...' });
  wp(
    [
      'core',
      'install',
      `--url=http://${domain}`,
      `--title=${title || name}`,
      `--admin_user=${adminUser}`,
      `--admin_password=${adminPassword}`,
      `--admin_email=${adminEmail || `admin@${domain}`}`,
      '--skip-email',
    ],
    sitePath
  );

  // 6. Ensure the newest bundled default theme is active. WP activates it
  // automatically on a fresh install, but do it explicitly so the site always
  // lands on the latest Twenty* theme even if that ever changes.
  progress({ step: 'theme', message: 'Activating default theme...' });
  activateLatestDefaultTheme(sitePath);

  // 7. Create nginx config
  progress({ step: 'nginx', message: 'Configuring nginx...' });
  nginx.createSiteConfig({ name, domain, path: sitePath, phpVersion });

  // 8. Reload nginx
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
    wpVersion = sanitizeWpVersion(wp(['core', 'version'], sitePath)) || 'unknown';
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

// Activates the latest bundled core default theme (the newest Twenty* theme).
// Uses WP_Theme::get_core_default_theme() — the same lookup WordPress itself
// uses to pick the fallback theme — so it always resolves to the newest one
// shipped with this WP version. Best-effort: never fails the site creation.
function activateLatestDefaultTheme(sitePath) {
  try {
    const latest = wp(
      [
        'eval',
        'if ($t = WP_Theme::get_core_default_theme()) { echo $t->get_stylesheet(); }',
      ],
      sitePath
    ).trim();
    if (latest) {
      wp(['theme', 'activate', latest], sitePath);
    }
  } catch {
    // A fresh install already activates the newest default theme, so this is
    // only a best-effort guarantee.
  }
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

// Updates a site's WordPress home/siteurl options so WP generates links with
// the given scheme (http/https). Best-effort — a fresh or broken install may
// not respond, in which case nginx still serves the chosen scheme.
function setSiteUrl(sitePath, url) {
  wp(['option', 'update', 'home', url], sitePath);
  wp(['option', 'update', 'siteurl', url], sitePath);
}

function getSiteWordPressVersion(sitePath) {
  try {
    return sanitizeWpVersion(wp(['core', 'version'], sitePath));
  } catch {
    return null;
  }
}

function getWordPressInfo(sitePath) {
  if (!fs.existsSync(path.join(sitePath, 'wp-config.php'))) {
    return null;
  }
  try {
    const version = sanitizeWpVersion(wp(['core', 'version'], sitePath));
    const siteUrl = wp(['option', 'get', 'siteurl'], sitePath);
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
  setSiteUrl,
  getSiteWordPressVersion,
  getWordPressInfo,
  sanitizeDomain,
  sanitizeDbName,
  generateId,
};
