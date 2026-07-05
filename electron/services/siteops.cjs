'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const mysql = require('./mysql.cjs');
const nginx = require('./nginx.cjs');
const wordpress = require('./wordpress.cjs');
const archive = require('./archive.cjs');
const wpress = require('./wpress.cjs');
const mkcert = require('./mkcert.cjs');
const { DOMAIN_RE } = require('./validation.cjs');

// Shared engine behind Export, Import, Clone, and Blueprints. Every entry
// point streams {step, message} progress objects like createWordPressSite
// does, and long WP-CLI calls run through wpAsync with a 10-minute budget so
// big databases don't trip the default 2-minute timeout.

const MANIFEST_NAME = 'wpherd-manifest.json';
const LONG_TIMEOUT = 600000;

// AIO housekeeping entries that must not be copied into wp-content.
const WPRESS_SKIP = new Set([
  'database.sql',
  'package.json',
  'multisite.json',
  'blogs.json',
  'filemap.json',
]);

// Lazily resolved so vitest can import the pure helpers without electron.
function getTmpRoot() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'tmp');
  } catch {
    return path.join(os.tmpdir(), 'wpherd-tmp');
  }
}

function makeTmpDir() {
  const root = getTmpRoot();
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'job-'));
}

// ─── Manifest (pure) ─────────────────────────────────────────────────────

function buildManifest(site, { tablePrefix = 'wp_' } = {}) {
  return {
    format: 'wpherd-site',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    name: site.name,
    domain: site.domain,
    url: site.url || `http://${site.domain}`,
    phpVersion: site.phpVersion,
    wpVersion: site.wpVersion || 'unknown',
    dbName: site.dbName,
    https: !!site.https,
    tablePrefix,
    adminUser: site.adminUser,
    adminEmail: site.adminEmail,
  };
}

function validateManifest(obj) {
  if (!obj || typeof obj !== 'object') {
    throw new Error('The archive manifest is not valid JSON.');
  }
  if (obj.format !== 'wpherd-site') {
    throw new Error('This archive was not exported by WPHerd.');
  }
  if (obj.formatVersion !== 1) {
    throw new Error(
      `This archive uses format version ${obj.formatVersion}, which this version of WPHerd cannot read.`
    );
  }
  if (typeof obj.domain !== 'string' || !DOMAIN_RE.test(obj.domain)) {
    throw new Error('The archive manifest contains an invalid domain.');
  }
  if (obj.tablePrefix != null && !/^[a-zA-Z0-9_]{1,32}$/.test(obj.tablePrefix)) {
    throw new Error('The archive manifest contains an invalid table prefix.');
  }
  return obj;
}

// ─── Import-kind detection (pure) ────────────────────────────────────────

function detectImportKind(ext, entries) {
  if (ext === '.wpress') return 'wpress';
  if (entries.some((e) => e === MANIFEST_NAME)) return 'wpherd';
  return 'generic';
}

// Extracts the host from a URL-ish string, or null.
function urlHost(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname || null;
  } catch {
    return null;
  }
}

// Sniffs the WordPress table prefix from the head of a SQL dump.
function detectTablePrefix(sqlHead) {
  const m = sqlHead.match(/CREATE TABLE `?([a-zA-Z0-9_]+?)(?:options|posts|users)`?[\s(]/);
  return m ? m[1] : null;
}

function readSqlHead(sqlFile, bytes = 1024 * 1024) {
  const fd = fs.openSync(sqlFile, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, read);
  } finally {
    fs.closeSync(fd);
  }
}

// ─── Inspect ─────────────────────────────────────────────────────────────

// Cheap pre-import probe used by the wizard to prefill fields and warn early.
async function inspectArchive(archivePath) {
  if (!fs.existsSync(archivePath)) {
    throw new Error('The selected file no longer exists.');
  }
  const ext = path.extname(archivePath).toLowerCase();
  const baseSlug = wordpress.sanitizeDomain(
    path.basename(archivePath, ext).replace(/-export$/, '')
  );

  if (ext === '.wpress') {
    let originUrl = null;
    let multisite = false;
    try {
      const pkgBuf = wpress.readWpressEntry(archivePath, 'package.json');
      if (pkgBuf) {
        const pkg = JSON.parse(pkgBuf.toString('utf8'));
        originUrl = pkg.SiteURL || pkg.HomeURL || null;
        multisite = !!(pkg.Multisite || pkg.Network);
      }
    } catch {
      // parse failures surface at import time with a clearer message
    }
    return {
      kind: 'wpress',
      originUrl,
      suggestedName: baseSlug || 'imported-site',
      warning: multisite
        ? 'This archive appears to contain a multisite network, which WPHerd does not support.'
        : null,
    };
  }

  const entries = await archive.listZipEntries(archivePath);
  const kind = detectImportKind(ext, entries);

  if (kind === 'wpherd') {
    const raw = await archive.readZipEntry(archivePath, MANIFEST_NAME);
    const manifest = validateManifest(JSON.parse(raw));
    return {
      kind,
      manifest,
      originUrl: manifest.url,
      suggestedName: manifest.name || manifest.domain.replace(/\.test$/, ''),
      warning: null,
    };
  }

  const hasWp = entries.some((e) => e.endsWith('wp-settings.php'));
  const hasSql = entries.some((e) => e.toLowerCase().endsWith('.sql'));
  let warning = null;
  if (!hasWp && !hasSql) {
    warning =
      'No WordPress files or SQL dump were found in this archive — the import will likely fail.';
  } else if (!hasWp) {
    warning = 'No WordPress core files found — only the database will be imported.';
  } else if (!hasSql) {
    warning = 'No SQL dump found in this archive — the site database will be empty.';
  }
  return { kind, originUrl: null, suggestedName: baseSlug || 'imported-site', warning };
}

// ─── Export ──────────────────────────────────────────────────────────────

async function exportSite(site, outZip, onProgress) {
  const progress = onProgress || (() => {});
  if (!fs.existsSync(site.path)) {
    throw new Error(`Site directory not found: ${site.path}`);
  }
  const staging = makeTmpDir();
  try {
    progress({ step: 'dump', message: 'Dumping database...' });
    await mysql.dumpDatabase(site.dbName, path.join(staging, 'database.sql'));

    progress({ step: 'manifest', message: 'Writing manifest...' });
    let tablePrefix = 'wp_';
    try {
      tablePrefix =
        (await wordpress.wpAsync(['config', 'get', 'table_prefix'], site.path)) || 'wp_';
    } catch {}
    fs.writeFileSync(
      path.join(staging, MANIFEST_NAME),
      JSON.stringify(buildManifest(site, { tablePrefix }), null, 2)
    );

    progress({ step: 'archive', message: 'Compressing site files...' });
    // Symlink instead of copying — zip (without -y) follows the link and
    // materializes the site files inside the archive under files/.
    fs.symlinkSync(site.path, path.join(staging, 'files'));
    await archive.zipDirectory(staging, outZip);

    progress({ step: 'done', message: 'Export complete.' });
    return { sizeBytes: fs.statSync(outZip).size };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// ─── Import ──────────────────────────────────────────────────────────────

// Finds the shallowest directory containing wp-settings.php (BFS).
function findWpRoot(dir) {
  const queue = [dir];
  while (queue.length > 0) {
    const current = queue.shift();
    if (fs.existsSync(path.join(current, 'wp-settings.php'))) return current;
    for (const name of fs.readdirSync(current)) {
      const p = path.join(current, name);
      try {
        if (fs.lstatSync(p).isDirectory()) queue.push(p);
      } catch {}
    }
  }
  return null;
}

function findLargestSql(dir) {
  let best = null;
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.toLowerCase().endsWith('.sql') && (!best || st.size > best.size)) {
        best = { path: p, size: st.size };
      }
    }
  };
  walk(dir);
  return best ? best.path : null;
}

// Moves a directory, falling back to copy+delete across volumes.
function moveDir(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch {
    fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

// Imports an archive as a brand-new site. `target` is pre-validated by the
// IPC handler ({name, domain, path, phpVersion, dbName} — unique domain/db,
// safe path). Cleans up everything it created if any step fails.
async function importSite(archivePath, target, onProgress) {
  const progress = onProgress || (() => {});
  const ledger = { dirCreated: false, dbCreated: false, vhostWritten: false };
  const tmp = makeTmpDir();
  try {
    const ext = path.extname(archivePath).toLowerCase();
    const kind = ext === '.wpress' ? 'wpress' : 'zip';

    progress({ step: 'extract', message: 'Extracting archive...' });
    if (kind === 'wpress') {
      await wpress.extractWpress(archivePath, tmp);
    } else {
      await archive.extractZip(archivePath, tmp);
    }
    const zipKind =
      kind === 'wpress'
        ? 'wpress'
        : fs.existsSync(path.join(tmp, MANIFEST_NAME))
          ? 'wpherd'
          : 'generic';

    // Manifest (wpherd archives only) — carries origin URL and table prefix.
    let manifest = null;
    if (zipKind === 'wpherd') {
      manifest = validateManifest(
        JSON.parse(fs.readFileSync(path.join(tmp, MANIFEST_NAME), 'utf8'))
      );
    }

    // Locate the SQL dump before touching the filesystem/database.
    let sqlFile = null;
    if (zipKind === 'wpherd' || zipKind === 'wpress') {
      const p = path.join(tmp, 'database.sql');
      sqlFile = fs.existsSync(p) ? p : null;
      if (!sqlFile && zipKind === 'wpress') {
        throw new Error('This .wpress archive does not contain a database.sql.');
      }
    } else {
      sqlFile = findLargestSql(tmp);
      // The dump may live inside the WordPress root that the files step is
      // about to move — park a copy outside the extract tree so the database
      // step always has a valid path.
      if (sqlFile) {
        const stable = `${tmp}-database.sql`;
        fs.copyFileSync(sqlFile, stable);
        sqlFile = stable;
      }
    }

    // Multisite guard — WPHerd vhosts and tooling are single-site only.
    if (sqlFile) {
      const head = readSqlHead(sqlFile);
      if (/CREATE TABLE `?(?:[a-zA-Z0-9_]+?)blogs`?[\s(]/.test(head)) {
        throw new Error(
          'This archive contains a multisite network, which WPHerd does not support yet.'
        );
      }
    }

    progress({ step: 'files', message: 'Placing site files...' });
    if (fs.existsSync(target.path) && fs.readdirSync(target.path).length > 0) {
      throw new Error(`${target.path} already exists and is not empty.`);
    }
    if (zipKind === 'wpherd') {
      const filesDir = path.join(tmp, 'files');
      if (!fs.existsSync(filesDir)) {
        throw new Error('This WPHerd archive is missing its files/ directory.');
      }
      moveDir(filesDir, target.path);
      ledger.dirCreated = true;
    } else if (zipKind === 'generic') {
      const wpRoot = findWpRoot(tmp);
      if (!wpRoot) {
        throw new Error(
          'No WordPress installation (wp-settings.php) was found in this archive.'
        );
      }
      moveDir(wpRoot, target.path);
      ledger.dirCreated = true;
    } else {
      // .wpress payload is wp-content only — download core, then lay the
      // payload into wp-content.
      fs.mkdirSync(target.path, { recursive: true });
      ledger.dirCreated = true;
      progress({ step: 'files', message: 'Downloading WordPress core...' });
      await wordpress.wpAsync(['core', 'download'], target.path, {
        timeout: LONG_TIMEOUT,
      });
      const wpContent = path.join(target.path, 'wp-content');
      for (const name of fs.readdirSync(tmp)) {
        if (WPRESS_SKIP.has(name)) continue;
        const src = path.join(tmp, name);
        const dest = path.join(wpContent, name);
        fs.rmSync(dest, { recursive: true, force: true });
        moveDir(src, dest);
      }
    }

    // Database
    progress({ step: 'database', message: 'Importing database...' });
    let importSql = sqlFile;
    let tablePrefix = manifest?.tablePrefix || 'wp_';
    if (sqlFile && zipKind === 'wpress' && wpress.sqlContainsServmaskPrefix(sqlFile)) {
      importSql = await wpress.rewriteServmaskSql(sqlFile, 'wp_');
      tablePrefix = 'wp_';
    } else if (sqlFile && zipKind === 'generic') {
      tablePrefix = detectTablePrefix(readSqlHead(sqlFile)) || 'wp_';
    }
    mysql.createDatabase(target.dbName);
    ledger.dbCreated = true;
    if (importSql) {
      await mysql.importDatabase(target.dbName, importSql);
    }

    // wp-config.php
    progress({ step: 'config', message: 'Configuring WordPress...' });
    const { user: dbUser, password: dbPass } = mysql.getCredentials();
    if (fs.existsSync(path.join(target.path, 'wp-config.php'))) {
      // Keep custom constants; just point the install at the new database.
      for (const [key, value] of [
        ['DB_NAME', target.dbName],
        ['DB_USER', dbUser],
        ['DB_PASSWORD', dbPass],
        ['DB_HOST', 'localhost'],
      ]) {
        await wordpress.wpAsync(['config', 'set', key, value], target.path);
      }
    } else {
      await wordpress.wpAsync(
        [
          'config',
          'create',
          `--dbname=${target.dbName}`,
          `--dbuser=${dbUser}`,
          `--dbpass=${dbPass}`,
          '--dbhost=localhost',
          '--force',
        ],
        target.path
      );
    }
    if (tablePrefix !== 'wp_') {
      await wordpress.wpAsync(
        ['config', 'set', 'table_prefix', tablePrefix],
        target.path
      );
    }

    // URLs — rewrite the origin host across all tables, then set home/siteurl.
    progress({ step: 'urls', message: 'Updating site URLs...' });
    const newUrl = `http://${target.domain}`;
    let originHost = urlHost(manifest?.url);
    if (!originHost && sqlFile) {
      try {
        originHost = urlHost(
          await wordpress.wpAsync(['option', 'get', 'siteurl'], target.path)
        );
      } catch {}
    }
    if (originHost && originHost !== target.domain) {
      await wordpress.wpAsync(
        [
          'search-replace',
          `//${originHost}`,
          `//${target.domain}`,
          '--all-tables',
          '--skip-columns=guid',
        ],
        target.path,
        { timeout: LONG_TIMEOUT }
      );
    }
    try {
      wordpress.setSiteUrl(target.path, newUrl);
    } catch {}

    // nginx vhost
    progress({ step: 'nginx', message: 'Configuring nginx...' });
    nginx.createSiteConfig({
      name: target.name,
      domain: target.domain,
      path: target.path,
      phpVersion: target.phpVersion,
    });
    ledger.vhostWritten = true;
    try {
      nginx.reload();
    } catch {}

    progress({ step: 'done', message: 'Site imported!' });

    let wpVersion = 'unknown';
    try {
      wpVersion =
        (await wordpress.wpAsync(['core', 'version'], target.path)).match(
          /^\d+\.\d+(?:\.\d+)*$/
        )?.[0] || 'unknown';
    } catch {}

    return {
      id: wordpress.generateId(),
      name: target.name,
      domain: target.domain,
      path: target.path,
      phpVersion: target.phpVersion,
      dbName: target.dbName,
      adminUser: manifest?.adminUser || 'admin',
      adminEmail: manifest?.adminEmail || `admin@${target.domain}`,
      wpVersion,
      url: newUrl,
      createdAt: new Date().toISOString(),
    };
  } catch (err) {
    // Roll back only the resources this import created.
    if (ledger.vhostWritten) {
      try {
        nginx.removeSiteConfig(target.domain);
        nginx.reload();
      } catch {}
    }
    if (ledger.dbCreated) {
      try {
        mysql.dropDatabase(target.dbName);
      } catch {}
    }
    if (ledger.dirCreated) {
      try {
        fs.rmSync(target.path, { recursive: true, force: true });
      } catch {}
    }
    throw err;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(`${tmp}-database.sql`, { force: true });
  }
}

// ─── Shared helpers ──────────────────────────────────────────────────────

// Rewrites every occurrence of `//oldHost` to `//newHost` across all tables
// (guids left alone — WordPress keys post lookups on them). No-op when the
// hosts match.
async function searchReplaceHost(sitePath, oldHost, newHost) {
  if (!oldHost || oldHost === newHost) return;
  await wordpress.wpAsync(
    [
      'search-replace',
      `//${oldHost}`,
      `//${newHost}`,
      '--all-tables',
      '--skip-columns=guid',
    ],
    sitePath,
    { timeout: LONG_TIMEOUT }
  );
}

// Mints a trusted local cert for `domain`, ensuring mkcert + the local CA are
// in place first. Returns { certPath, keyPath }.
function mintCert(domain) {
  mkcert.ensureInstalled();
  mkcert.ensureCA();
  return mkcert.generateCert(domain);
}

// ─── Clone ───────────────────────────────────────────────────────────────

// Duplicates `source` into a brand-new site at `target` ({name, domain, path,
// phpVersion, dbName} — pre-validated by the IPC handler). The source site is
// never touched. The clone does NOT inherit the magic-login secret or the
// one-click-admin / alias settings (those are per-site). Rolls back anything
// it created on failure.
async function cloneSite(source, target, onProgress) {
  const progress = onProgress || (() => {});
  if (!fs.existsSync(source.path)) {
    throw new Error(`Source site directory not found: ${source.path}`);
  }
  const ledger = { dirCreated: false, dbCreated: false, vhostWritten: false };
  const staging = makeTmpDir();
  try {
    progress({ step: 'files', message: 'Copying site files...' });
    fs.cpSync(source.path, target.path, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
    ledger.dirCreated = true;

    progress({ step: 'database', message: 'Copying database...' });
    const dumpFile = path.join(staging, 'clone.sql');
    await mysql.dumpDatabase(source.dbName, dumpFile);
    mysql.createDatabase(target.dbName);
    ledger.dbCreated = true;
    await mysql.importDatabase(target.dbName, dumpFile);

    progress({ step: 'config', message: 'Configuring WordPress...' });
    await wordpress.wpAsync(['config', 'set', 'DB_NAME', target.dbName], target.path);
    // Don't leak the source's magic-login secret into the clone.
    wordpress.removeMagicLoginMuPlugin(target.path);

    progress({ step: 'urls', message: 'Updating site URLs...' });
    await searchReplaceHost(target.path, source.domain, target.domain);

    const https = !!source.https;
    let certPath, keyPath;
    if (https) {
      progress({ step: 'cert', message: 'Creating HTTPS certificate...' });
      ({ certPath, keyPath } = mintCert(target.domain));
    }
    const newUrl = `${https ? 'https' : 'http'}://${target.domain}`;

    progress({ step: 'nginx', message: 'Configuring nginx...' });
    const site = {
      id: wordpress.generateId(),
      name: target.name,
      domain: target.domain,
      path: target.path,
      phpVersion: target.phpVersion,
      dbName: target.dbName,
      adminUser: source.adminUser || 'admin',
      adminEmail: source.adminEmail || `admin@${target.domain}`,
      wpVersion: source.wpVersion || 'unknown',
      https,
      ...(https ? { certPath, keyPath } : {}),
      url: newUrl,
      createdAt: new Date().toISOString(),
    };
    nginx.createSiteConfig(site);
    ledger.vhostWritten = true;
    try {
      nginx.reload();
    } catch {}
    try {
      wordpress.setSiteUrl(target.path, newUrl);
    } catch {}

    progress({ step: 'done', message: 'Clone complete!' });
    return site;
  } catch (err) {
    if (ledger.vhostWritten) {
      try {
        nginx.removeSiteConfig(target.domain);
        nginx.reload();
      } catch {}
    }
    if (ledger.dbCreated) {
      try {
        mysql.dropDatabase(target.dbName);
      } catch {}
    }
    if (ledger.dirCreated) {
      try {
        fs.rmSync(target.path, { recursive: true, force: true });
      } catch {}
    }
    throw err;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// ─── Change URL ──────────────────────────────────────────────────────────

// Renames a site's domain in place. Ordered so the site is never unreachable:
// mint the cert, write the NEW vhost first, rewrite the database, then remove
// the old vhost and cert last. id / dbName / path are unchanged. Returns the
// fields the store needs to merge: { domain, url, certPath, keyPath }.
async function changeSiteUrl(site, newDomain, onProgress) {
  const progress = onProgress || (() => {});
  const oldDomain = site.domain;
  const https = !!site.https;
  const newUrl = `${https ? 'https' : 'http'}://${newDomain}`;

  let certPath, keyPath;
  if (https) {
    progress({ step: 'cert', message: 'Creating HTTPS certificate...' });
    ({ certPath, keyPath } = mintCert(newDomain));
  }

  // New vhost goes live before we touch the database so the new domain
  // resolves the moment DNS (dnsmasq wildcard *.test) points at it.
  progress({ step: 'nginx', message: 'Writing new nginx config...' });
  const updated = {
    ...site,
    domain: newDomain,
    url: newUrl,
    ...(https ? { certPath, keyPath } : {}),
  };
  nginx.createSiteConfig(updated);
  try {
    nginx.reload();
  } catch {}

  progress({ step: 'urls', message: 'Updating database URLs...' });
  await searchReplaceHost(site.path, oldDomain, newDomain);
  try {
    wordpress.setSiteUrl(site.path, newUrl);
  } catch {}

  // Old vhost + cert removed last, best-effort.
  progress({ step: 'cleanup', message: 'Removing old configuration...' });
  if (newDomain !== oldDomain) {
    try {
      nginx.removeSiteConfig(oldDomain);
      nginx.reload();
    } catch {}
    if (https) {
      try {
        mkcert.removeCert(oldDomain);
      } catch {}
    }
  }

  progress({ step: 'done', message: 'URL changed!' });
  return { domain: newDomain, url: newUrl, certPath, keyPath };
}

module.exports = {
  MANIFEST_NAME,
  buildManifest,
  validateManifest,
  detectImportKind,
  detectTablePrefix,
  urlHost,
  inspectArchive,
  exportSite,
  importSite,
  cloneSite,
  changeSiteUrl,
};
