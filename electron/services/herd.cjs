'use strict';

// ── Laravel Herd: the sites it serves, read from its own config ──────────────
// Herd is Valet underneath, and it keeps everything as files, so this reads
// them directly — Herd needn't be running, and its CLI needn't be on $PATH:
//
//   <root>/config/valet/config.json   { tld, paths: [...] } — parked dirs
//   <root>/config/valet/Sites/<name>  symlink → a linked site's folder
//   <root>/config/valet/Certificates/<domain>.crt   present ⇒ served on HTTPS
//   <root>/config/valet/Nginx/<domain>  per-site vhost; `$herd_sock_84` in it
//                                       means the site is isolated to PHP 8.4
//   <root>/bin/php → php83              the global PHP version
//
// Every subfolder of a parked dir is `<folder>.<tld>`; Valet's own Sites dir
// is listed among the parked paths, and a link wins over a parked folder of
// the same name, as it does in Herd.
//
// WPXen *adopts* a Herd WordPress site in place (see ipc.cjs `herd-adopt`):
// same folder, same database, same domain. Nothing here writes anything.
//
// Electron-free; `root` is the test seam.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DB_NAME_RE } = require('./validation.cjs');

function defaultRoot() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Herd');
}

function valetDir(root) {
  return path.join(root, 'config', 'valet');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isInstalled(root = defaultRoot()) {
  return fs.existsSync(path.join(valetDir(root), 'config.json'));
}

// The global PHP version, from the `bin/php` → `php83` link. Null if unknown.
function globalPhpVersion(root = defaultRoot()) {
  try {
    const target = path.basename(fs.readlinkSync(path.join(root, 'bin', 'php')));
    return phpFromDigits(target.match(/^php(\d{2,3})$/)?.[1]);
  } catch {
    return null;
  }
}

// '84' → '8.4', '74' → '7.4'. Pure.
function phpFromDigits(digits) {
  if (!digits || !/^\d{2,3}$/.test(digits)) return null;
  return `${digits[0]}.${digits.slice(1)}`;
}

// The PHP version a Herd vhost pins, or null when it uses the global one. Pure.
function isolatedPhpFromVhost(text) {
  const m = String(text || '').match(/fastcgi_pass\s+\$herd_sock_(\d{2,3})\s*;/);
  return m ? phpFromDigits(m[1]) : null;
}

// What WPXen needs from a wp-config.php. Pure: string in, values out.
// Only literal string defines are read — a value computed in PHP (getenv,
// a constant) comes back null rather than guessed.
function parseWpConfig(text) {
  const src = String(text || '');
  const define = (name) => {
    const re = new RegExp(
      `define\\s*\\(\\s*['"]${name}['"]\\s*,\\s*(['"])((?:\\\\.|(?!\\1).)*)\\1\\s*\\)`
    );
    const m = src.match(re);
    return m ? m[2].replace(/\\(.)/g, '$1') : null;
  };
  const truthy = (name) =>
    new RegExp(
      `define\\s*\\(\\s*['"]${name}['"]\\s*,\\s*(true|1|['"]true['"])\\s*\\)`,
      'i'
    ).test(src);
  const prefix = src.match(/\$table_prefix\s*=\s*(['"])([A-Za-z0-9_]*)\1/);
  return {
    dbName: define('DB_NAME'),
    dbHost: define('DB_HOST'),
    tablePrefix: prefix ? prefix[2] : null,
    multisite: truthy('MULTISITE') || truthy('WP_ALLOW_MULTISITE'),
  };
}

// A DB_HOST that reaches this machine's default MySQL — the server WPXen
// runs. A port other than 3306 or a remote host is someone else's server.
function isLocalDbHost(host) {
  const h = String(host || '')
    .trim()
    .toLowerCase();
  if (!h) return false;
  const [name, port] = h.split(':');
  if (!['localhost', '127.0.0.1', '::1'].includes(name)) return false;
  // `localhost:/path/to/mysql.sock` is a socket on this machine.
  return port == null || port === '3306' || port.startsWith('/');
}

// Folder → `<folder>.<tld>`, lowercased (DNS is case-insensitive, and
// WPXen's domains are lowercase). Null for a name no domain can carry.
function domainFor(name, tld) {
  const label = String(name || '').toLowerCase();
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(label)) return null;
  return `${label}.${tld}`;
}

function isWordPressRoot(dir) {
  return (
    fs.existsSync(path.join(dir, 'wp-config.php')) &&
    fs.existsSync(path.join(dir, 'wp-settings.php'))
  );
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Every site Herd serves: [{ name, domain, path, linked }]. Links first, so a
// parked folder of the same name is dropped the way Herd drops it.
function listServedSites(root = defaultRoot()) {
  const config = readJson(path.join(valetDir(root), 'config.json'));
  if (!config) return [];
  const tld = typeof config.tld === 'string' && config.tld ? config.tld : 'test';
  const sitesDir = path.resolve(valetDir(root), 'Sites');
  const parked = [
    ...new Set(
      (config.paths || [])
        .filter((p) => typeof p === 'string')
        .map((p) => path.resolve(p))
    ),
  ];

  const out = [];
  const seen = new Set();
  const add = (name, dir, linked) => {
    const domain = domainFor(name, tld);
    if (!domain || seen.has(domain)) return;
    let real;
    try {
      real = fs.realpathSync(dir);
      if (!fs.statSync(real).isDirectory()) return;
    } catch {
      return; // a dangling link
    }
    seen.add(domain);
    out.push({ name, domain, path: real, linked });
  };

  for (const entry of listDirs(sitesDir))
    add(entry.name, path.join(sitesDir, entry.name), true);
  for (const dir of parked) {
    if (dir === sitesDir) continue;
    for (const entry of listDirs(dir)) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        add(entry.name, path.join(dir, entry.name), false);
      }
    }
  }
  return out;
}

// The Herd sites that are WordPress installs, with what adoption needs:
// [{ name, domain, path, linked, secured, phpVersion, dbName, dbHost,
//    tablePrefix, multisite }]. Sorted by domain.
function listWordPressSites(root = defaultRoot()) {
  if (!isInstalled(root)) return [];
  const globalPhp = globalPhpVersion(root);
  const vdir = valetDir(root);
  const sites = [];
  for (const site of listServedSites(root)) {
    if (!isWordPressRoot(site.path)) continue;
    let config = {};
    try {
      config = parseWpConfig(
        fs.readFileSync(path.join(site.path, 'wp-config.php'), 'utf8')
      );
    } catch {}
    let vhost = '';
    try {
      vhost = fs.readFileSync(path.join(vdir, 'Nginx', site.domain), 'utf8');
    } catch {}
    sites.push({
      ...site,
      secured: fs.existsSync(path.join(vdir, 'Certificates', `${site.domain}.crt`)),
      phpVersion: isolatedPhpFromVhost(vhost) || globalPhp,
      dbName: config.dbName || null,
      dbHost: config.dbHost || null,
      tablePrefix: config.tablePrefix || null,
      multisite: !!config.multisite,
    });
  }
  return sites.sort((a, b) => a.domain.localeCompare(b.domain));
}

// Why a Herd site can't be adopted, or null when it can. Pure: everything it
// weighs is passed in, so the rules are testable without MySQL or nginx.
//   ctx.sites          WPXen's Site records
//   ctx.dbExists(name) whether the database exists on WPXen's MySQL
//   ctx.vhostExists(domain)  whether WPXen's nginx already has that domain
function adoptionBlocker(herdSite, ctx) {
  const same = (a, b) => path.resolve(a) === path.resolve(b);
  const existing = (ctx.sites || []).find(
    (s) => s.domain === herdSite.domain || (s.path && same(s.path, herdSite.path))
  );
  if (existing)
    return { code: 'imported', message: `Already in WPXen as ${existing.name}.` };
  if (herdSite.multisite) {
    return { code: 'multisite', message: 'Multisite networks are not supported yet.' };
  }
  if (!herdSite.dbName) {
    return {
      code: 'db-unreadable',
      message: 'wp-config.php has no literal DB_NAME WPXen can read.',
    };
  }
  // The one rule WPXen's MySQL layer quotes safely (validation.cjs).
  if (!DB_NAME_RE.test(herdSite.dbName)) {
    return {
      code: 'db-name-unsupported',
      message: `Database name ${herdSite.dbName} uses characters WPXen doesn't support.`,
    };
  }
  if (!isLocalDbHost(herdSite.dbHost)) {
    return {
      code: 'db-elsewhere',
      message: `The database is on ${herdSite.dbHost || 'an unknown host'}, not WPXen's MySQL.`,
    };
  }
  if (!ctx.dbExists(herdSite.dbName)) {
    return {
      code: 'db-missing',
      message: `Database ${herdSite.dbName} was not found on WPXen's MySQL.`,
    };
  }
  if (ctx.vhostExists(herdSite.domain)) {
    return {
      code: 'domain-taken',
      message: `WPXen's nginx already has a config for ${herdSite.domain}.`,
    };
  }
  return null;
}

// The PHP version to serve an adopted site with: Herd's if WPXen has it
// installed, else WPXen's active one, else the first installed. Pure.
function pickPhpVersion(herdVersion, installed) {
  const versions = (installed || []).map((v) => (typeof v === 'string' ? v : v.version));
  if (herdVersion && versions.includes(herdVersion)) return herdVersion;
  const active = (installed || []).find((v) => v && v.active)?.version;
  return active || versions[0] || null;
}

module.exports = {
  defaultRoot,
  isInstalled,
  globalPhpVersion,
  phpFromDigits,
  isolatedPhpFromVhost,
  parseWpConfig,
  isLocalDbHost,
  domainFor,
  listServedSites,
  listWordPressSites,
  adoptionBlocker,
  pickPhpVersion,
};
