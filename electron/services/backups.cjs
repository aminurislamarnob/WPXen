'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const mysql = require('./mysql.cjs');
const siteops = require('./siteops.cjs');
const archive = require('./archive.cjs');
const wordpress = require('./wordpress.cjs');

// Per-site backup snapshots: each is a full WPHerd export archive (files + DB
// dump + manifest) stored at userData/backups/<siteId>/<id>.zip, with a
// metadata record in the store under 'backups' — the exact blueprints.cjs
// pattern, plus scheduling metadata (trigger), retention pruning, and an
// in-place restore that reuses the export/import engine.

// Refuse to start an export when the volume is nearly full — a failed zip of
// a media-heavy site can otherwise wedge the machine.
const MIN_FREE_BYTES = 1024 * 1024 * 1024; // 1 GiB

function getBackupsRoot() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'backups');
  } catch {
    return path.join(os.tmpdir(), 'wpherd-backups');
  }
}

function getBackupsDir(siteId) {
  const dir = path.join(getBackupsRoot(), siteId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTmpDir() {
  const root = path.join(getBackupsRoot(), '.tmp');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'restore-'));
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

function freeBytesAt(dir) {
  try {
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize;
  } catch {
    return Infinity; // can't tell — don't block the backup on it
  }
}

// ─── Create / list / delete ──────────────────────────────────────────────

async function createBackup(
  store,
  site,
  { note = '', trigger = 'manual' } = {},
  onProgress
) {
  const dir = getBackupsDir(site.id);
  if (freeBytesAt(dir) < MIN_FREE_BYTES) {
    throw new Error('Not enough free disk space to create a backup.');
  }
  const id = wordpress.generateId();
  const file = path.join(dir, `${id}.zip`);
  let sizeBytes = 0;
  try {
    ({ sizeBytes } = await siteops.exportSite(site, file, onProgress));
  } catch (err) {
    // Don't leave a half-written archive behind on failure.
    try {
      fs.rmSync(file, { force: true });
    } catch {}
    throw err;
  }
  const meta = {
    id,
    siteId: site.id,
    createdAt: new Date().toISOString(),
    sizeBytes,
    note: String(note || '').trim(),
    trigger,
    wpVersion: site.wpVersion || 'unknown',
    phpVersion: site.phpVersion,
    file,
    uploads: {},
  };
  store.set('backups', [...store.get('backups', []), meta]);

  // Stamp the site so the scheduler's due-date math starts from this run.
  const sites = store.get('sites', []);
  const idx = sites.findIndex((s) => s.id === site.id);
  if (idx !== -1) {
    sites[idx] = { ...sites[idx], lastBackupAt: meta.createdAt };
    store.set('sites', sites);
  }
  return meta;
}

// Returns a site's backups (newest first) whose archive still exists, healing
// the store of orphaned records — same self-heal as listBlueprints.
function listBackups(store, siteId) {
  const list = store.get('backups', []);
  const healed = list.filter((b) => b && b.file && fs.existsSync(b.file));
  if (healed.length !== list.length) {
    store.set('backups', healed);
  }
  return healed
    .filter((b) => !siteId || b.siteId === siteId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function findBackup(store, backupId) {
  return listBackups(store).find((b) => b.id === backupId) || null;
}

function deleteBackup(store, backupId) {
  const list = store.get('backups', []);
  const backup = list.find((b) => b.id === backupId);
  if (backup && backup.file) {
    try {
      fs.rmSync(backup.file, { force: true });
    } catch {}
  }
  store.set(
    'backups',
    list.filter((b) => b.id !== backupId)
  );
  return true;
}

// Merges a patch into one backup's metadata record (e.g. upload receipts).
function updateBackupMeta(store, backupId, patch) {
  const list = store.get('backups', []);
  const idx = list.findIndex((b) => b.id === backupId);
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...patch };
  store.set('backups', list);
  return list[idx];
}

// ─── Retention (pure core + applier) ─────────────────────────────────────

// Given a single site's backups, returns the ids to prune: everything beyond
// the newest `retainCount`, plus anything older than `maxAgeDays` (0 = no age
// limit). Pure — covered by vitest.
function selectBackupsToPrune(
  list,
  { retainCount = 5, maxAgeDays = 0 } = {},
  now = Date.now()
) {
  const keep = Math.max(1, Number(retainCount) || 1);
  const sorted = [...list].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const prune = new Set(sorted.slice(keep).map((b) => b.id));
  if (maxAgeDays > 0) {
    const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
    for (const b of sorted) {
      if (new Date(b.createdAt).getTime() < cutoff) prune.add(b.id);
    }
  }
  return sorted.filter((b) => prune.has(b.id)).map((b) => b.id);
}

function getRetentionSettings(store) {
  return {
    retainCount: store.get('settings.backups.retainCount', 5),
    maxAgeDays: store.get('settings.backups.maxAgeDays', 0),
  };
}

function applyRetention(store, siteId) {
  const ids = selectBackupsToPrune(
    listBackups(store, siteId),
    getRetentionSettings(store)
  );
  for (const id of ids) deleteBackup(store, id);
  return ids.length;
}

// ─── Restore (in place) ──────────────────────────────────────────────────

// Restores a backup over the existing site: files and database are replaced,
// domain/vhost/cert stay untouched. Destructive by design — an automatic
// pre-restore safety snapshot is taken first, so even a mid-restore failure
// (files swapped, database gone) is recoverable through the normal restore
// path. Returns { wpVersion, phpVersion } for the store to merge.
async function restoreBackup(store, site, backupId, onProgress) {
  const progress = onProgress || (() => {});
  const backup = listBackups(store, site.id).find((b) => b.id === backupId);
  if (!backup) throw new Error('That backup no longer exists.');

  progress({ step: 'safety', message: 'Creating a safety snapshot first...' });
  await createBackup(
    store,
    site,
    { note: 'Automatic pre-restore snapshot', trigger: 'pre-restore' },
    (p) => progress({ step: 'safety', message: `Safety snapshot: ${p.message}` })
  );

  const tmp = makeTmpDir();
  const oldDir = `${site.path}.wpherd-restoring`;
  let filesSwapped = false;
  try {
    progress({ step: 'extract', message: 'Extracting backup archive...' });
    await archive.extractZip(backup.file, tmp);

    const manifestPath = path.join(tmp, siteops.MANIFEST_NAME);
    if (!fs.existsSync(manifestPath)) {
      throw new Error('This backup archive is missing its manifest.');
    }
    const manifest = siteops.validateManifest(
      JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    );
    const filesDir = path.join(tmp, 'files');
    const sqlFile = path.join(tmp, 'database.sql');
    if (!fs.existsSync(filesDir)) {
      throw new Error('This backup archive is missing its files/ directory.');
    }
    if (!fs.existsSync(sqlFile)) {
      throw new Error('This backup archive is missing its database dump.');
    }

    progress({ step: 'files', message: 'Replacing site files...' });
    fs.rmSync(oldDir, { recursive: true, force: true });
    moveDir(site.path, oldDir);
    try {
      moveDir(filesDir, site.path);
      filesSwapped = true;
    } catch (err) {
      // Put the original files back — nothing else has been touched yet.
      moveDir(oldDir, site.path);
      throw err;
    }

    progress({ step: 'database', message: 'Restoring database...' });
    mysql.dropDatabase(site.dbName);
    mysql.createDatabase(site.dbName);
    await mysql.importDatabase(site.dbName, sqlFile);

    // The archived wp-config carries whatever credentials were current at
    // export time — re-point it at today's.
    progress({ step: 'config', message: 'Configuring WordPress...' });
    const { user: dbUser, password: dbPass } = mysql.getCredentials();
    for (const [key, value] of [
      ['DB_NAME', site.dbName],
      ['DB_USER', dbUser],
      ['DB_PASSWORD', dbPass],
      ['DB_HOST', 'localhost'],
    ]) {
      await wordpress.wpAsync(['config', 'set', key, value], site.path);
    }

    // If the site's domain changed since this backup was taken, rewrite it.
    progress({ step: 'urls', message: 'Updating site URLs...' });
    const originHost = siteops.urlHost(manifest.url) || manifest.domain;
    await siteops.searchReplaceHost(site.path, originHost, site.domain);
    try {
      wordpress.setSiteUrl(site.path, site.url || `http://${site.domain}`);
    } catch {}

    progress({ step: 'done', message: 'Restore complete.' });

    let wpVersion = backup.wpVersion || 'unknown';
    try {
      wpVersion =
        (await wordpress.wpAsync(['core', 'version'], site.path)).match(
          /^\d+\.\d+(?:\.\d+)*$/
        )?.[0] || wpVersion;
    } catch {}
    return { wpVersion };
  } finally {
    if (filesSwapped) {
      fs.rmSync(oldDir, { recursive: true, force: true });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ─── Usage ───────────────────────────────────────────────────────────────

function getTotalUsageBytes(store) {
  return listBackups(store).reduce((sum, b) => sum + (b.sizeBytes || 0), 0);
}

module.exports = {
  getBackupsRoot,
  getBackupsDir,
  createBackup,
  listBackups,
  findBackup,
  deleteBackup,
  updateBackupMeta,
  selectBackupsToPrune,
  applyRetention,
  restoreBackup,
  getTotalUsageBytes,
  freeBytesAt,
  MIN_FREE_BYTES,
};
