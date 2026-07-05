'use strict';

// Per-site local snapshots: a tar.gz of the site files plus a gzipped
// mysqldump, with a manifest written last (its presence marks a complete
// backup — a dir without one is an interrupted backup and gets cleaned up).
//
// Backups live under userData (not inside the site directory) so they never
// recursively include themselves in the next tar and never pollute the site's
// git repo: ~/Library/Application Support/WPHerd/backups/<siteId>/<timestamp>/
//   files.tar.gz  db.sql.gz  manifest.json
//
// Archiving shells out to macOS's bundled /usr/bin/tar via execFile argv
// arrays — no shell, no npm archive dependency — matching the conventions of
// the other service modules.

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const mysql = require('./mysql.cjs');
const wordpress = require('./wordpress.cjs');
const brew = require('./brew.cjs');

const execFileAsync = promisify(execFile);

const TAR_BIN = '/usr/bin/tar';
const MANIFEST_VERSION = 1;

// Sites currently being backed up or restored — one operation per site.
const inProgress = new Set();

// ─── Pure helpers (exported for tests) ─────────────────────────────────────

// 2026-07-05-142530 — sortable, filesystem-safe, local time.
function formatTimestamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

// Returns the timestamp when the dir name is a valid backup id, else null.
function parseBackupDirName(name) {
  return typeof name === 'string' && /^\d{4}-\d{2}-\d{2}-\d{6}$/.test(name)
    ? name
    : null;
}

function buildTarCreateArgs(sitePath, outFile) {
  return ['-czf', outFile, '-C', sitePath, '.'];
}

function buildTarExtractArgs(archive, destDir) {
  return ['-xzf', archive, '-C', destDir];
}

function buildManifest(site, { wpVersion, phpVersion, filesBytes, dbBytes } = {}) {
  return {
    version: MANIFEST_VERSION,
    siteId: site.id,
    siteName: site.name,
    domain: site.domain,
    url: site.url,
    dbName: site.dbName,
    createdAt: new Date().toISOString(),
    wpVersion: wpVersion || null,
    phpVersion: phpVersion || null,
    filesBytes: filesBytes ?? null,
    dbBytes: dbBytes ?? null,
  };
}

// True when candidate resolves to a path strictly inside root — the traversal
// guard for delete/restore paths built from stored values.
function isPathInside(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Site ids are generateId() base36 — anything else could traverse the
// backups root when used as a directory name.
function isSafeSiteId(id) {
  return typeof id === 'string' && /^[a-z0-9]{1,64}$/i.test(id);
}

// ─── Storage layout ─────────────────────────────────────────────────────────

function getBackupsRoot() {
  // Lazy require: this module's pure helpers are unit-tested outside Electron.
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'backups');
}

function getSiteBackupsDir(siteId) {
  if (!isSafeSiteId(siteId)) throw new Error('Invalid site id.');
  return path.join(getBackupsRoot(), siteId);
}

function getBackupDir(siteId, timestamp) {
  if (!parseBackupDirName(timestamp)) throw new Error('Invalid backup id.');
  const dir = path.join(getSiteBackupsDir(siteId), timestamp);
  if (!isPathInside(getBackupsRoot(), dir)) throw new Error('Invalid backup path.');
  return dir;
}

// ─── Operations ─────────────────────────────────────────────────────────────

async function runTar(args, timeoutMs = 600000) {
  if (!fs.existsSync(TAR_BIN)) {
    // Dev fallback (Linux CI containers); macOS always ships /usr/bin/tar.
    return execFileAsync('tar', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  }
  return execFileAsync(TAR_BIN, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
}

function guardConcurrent(siteId) {
  if (inProgress.has(siteId)) {
    throw new Error('A backup or restore is already running for this site.');
  }
  inProgress.add(siteId);
}

// Creates a snapshot of the site. `onProgress({ step, message })` mirrors the
// site-creation pipeline shape.
async function createBackup(site, onProgress = () => {}) {
  guardConcurrent(site.id);
  const timestamp = formatTimestamp();
  const dir = getBackupDir(site.id, timestamp);
  try {
    onProgress({ step: 'check', message: 'Checking services…' });
    if (!mysql.isRunning()) {
      throw new Error('MySQL is not running. Start it in the Services panel.');
    }
    if (!fs.existsSync(site.path)) {
      throw new Error(`Site directory not found: ${site.path}`);
    }

    fs.mkdirSync(dir, { recursive: true });

    onProgress({ step: 'database', message: `Dumping database ${site.dbName}…` });
    const dbFile = path.join(dir, 'db.sql.gz');
    await mysql.dumpDatabase(site.dbName, dbFile);

    onProgress({ step: 'files', message: 'Archiving site files…' });
    const filesArchive = path.join(dir, 'files.tar.gz');
    await runTar(buildTarCreateArgs(site.path, filesArchive));

    onProgress({ step: 'manifest', message: 'Writing manifest…' });
    let wpVersion = null;
    try {
      wpVersion = wordpress.getSiteWordPressVersion(site.path);
    } catch {}
    const manifest = buildManifest(site, {
      wpVersion,
      phpVersion: site.phpVersion || brew.getActivePhpVersion(),
      filesBytes: fs.statSync(filesArchive).size,
      dbBytes: fs.statSync(dbFile).size,
    });
    // Written last: a manifest on disk means every artifact before it is
    // complete. Crash-interrupted dirs (no manifest) are swept by listBackups.
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify(manifest, null, 2)
    );

    onProgress({ step: 'done', message: 'Backup complete.' });
    return { timestamp, manifest };
  } catch (err) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
    throw err;
  } finally {
    inProgress.delete(site.id);
  }
}

// Lists complete backups (newest first), sweeping interrupted ones.
function listBackups(siteId) {
  const siteDir = getSiteBackupsDir(siteId);
  if (!fs.existsSync(siteDir)) return [];
  const backups = [];
  for (const name of fs.readdirSync(siteDir)) {
    if (!parseBackupDirName(name)) continue;
    const dir = path.join(siteDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const manifestFile = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestFile)) {
      // Interrupted backup (app quit mid-run) — never restorable, remove it.
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
      continue;
    }
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      backups.push({ timestamp: name, ...manifest });
    } catch {
      // Corrupt manifest — skip rather than delete (the archives may be fine).
    }
  }
  return backups.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

// Restores a snapshot with a clean-slate strategy: the current site directory
// is parked next to itself, the archive extracts fresh, then the DB is dropped,
// recreated and re-imported. An extract failure rolls the directory back.
async function restoreBackup(site, timestamp, onProgress = () => {}) {
  guardConcurrent(site.id);
  const dir = getBackupDir(site.id, timestamp);
  const filesArchive = path.join(dir, 'files.tar.gz');
  const dbFile = path.join(dir, 'db.sql.gz');
  const parked = `${site.path}.wpherd-restore-tmp`;
  try {
    onProgress({ step: 'check', message: 'Verifying backup…' });
    if (!fs.existsSync(path.join(dir, 'manifest.json')) || !fs.existsSync(filesArchive)) {
      throw new Error('Backup is incomplete or missing.');
    }
    if (!mysql.isRunning()) {
      throw new Error('MySQL is not running. Start it in the Services panel.');
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));

    onProgress({ step: 'files', message: 'Restoring site files…' });
    // Clear a stale parked dir from an earlier crashed restore, then park the
    // live directory so extraction failures can roll back.
    fs.rmSync(parked, { recursive: true, force: true });
    if (fs.existsSync(site.path)) fs.renameSync(site.path, parked);
    fs.mkdirSync(site.path, { recursive: true });
    try {
      await runTar(buildTarExtractArgs(filesArchive, site.path));
    } catch (err) {
      fs.rmSync(site.path, { recursive: true, force: true });
      if (fs.existsSync(parked)) fs.renameSync(parked, site.path);
      throw new Error(`Restoring files failed: ${err.message}`);
    }

    onProgress({ step: 'database', message: `Restoring database ${site.dbName}…` });
    if (fs.existsSync(dbFile)) {
      mysql.dropDatabase(site.dbName);
      mysql.createDatabase(site.dbName);
      await mysql.importDatabase(site.dbName, dbFile);
    }

    onProgress({ step: 'cleanup', message: 'Cleaning up…' });
    fs.rmSync(parked, { recursive: true, force: true });

    // The dump carries the URL from backup time; if the site has changed
    // scheme since (http↔https), point WordPress back at the current URL.
    if (manifest.url && site.url && manifest.url !== site.url) {
      try {
        wordpress.setSiteUrl(site.path, site.url);
      } catch {}
    }

    onProgress({ step: 'done', message: 'Restore complete.' });
    return { timestamp };
  } finally {
    inProgress.delete(site.id);
  }
}

function deleteBackup(siteId, timestamp) {
  const dir = getBackupDir(siteId, timestamp);
  fs.rmSync(dir, { recursive: true, force: true });
}

function getBackupManifestPath(siteId, timestamp) {
  return path.join(getBackupDir(siteId, timestamp), 'manifest.json');
}

module.exports = {
  createBackup,
  listBackups,
  restoreBackup,
  deleteBackup,
  getBackupManifestPath,
  // Exported for tests
  formatTimestamp,
  parseBackupDirName,
  buildTarCreateArgs,
  buildTarExtractArgs,
  buildManifest,
  isPathInside,
  isSafeSiteId,
};
