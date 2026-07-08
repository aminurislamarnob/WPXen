'use strict';

const fs = require('fs');
const path = require('path');
const dropbox = require('./dropbox.cjs');
const gdrive = require('./gdrive.cjs');
const backups = require('../backups.cjs');
const wordpress = require('../wordpress.cjs');

// Provider registry + the backup↔cloud sync logic on top of it. Each provider
// implements the same adapter surface (connect/disconnect/upload/list/
// download/remove), so adding S3 later is a new module + one registry entry.

const PROVIDERS = { [dropbox.id]: dropbox, [gdrive.id]: gdrive };

function getProvider(providerId) {
  const provider = PROVIDERS[providerId];
  if (!provider) throw new Error(`Unknown cloud provider: ${providerId}`);
  return provider;
}

function listProviders() {
  return Object.values(PROVIDERS);
}

// Connection snapshot for the Settings cards.
function getStatus(store) {
  const status = {};
  for (const p of listProviders()) {
    status[p.id] = {
      id: p.id,
      name: p.name,
      configured: p.isConfigured(),
      connected: p.isConfigured() && p.isConnected(store),
      account: p.getAccount(store),
    };
  }
  return status;
}

// Archives are named "<domain>--<timestamp>--<backupId>.zip" locally and
// remotely (one shared convention — backups.backupFileName), so per-site
// listing is a plain prefix match and the backup id survives a round trip.
// Pure — tested.
function remoteNameFor(site, backup) {
  return backups.backupFileName(site.domain, backup.id, new Date(backup.createdAt));
}

function sitePrefix(site) {
  return `${site.domain}--`;
}

// Recovers the backup id: the segment after the LAST "--", so both the
// current "<domain>--<stamp>--<id>.zip" and the legacy "<domain>--<id>.zip"
// forms parse. Pure — tested.
function parseRemoteBackupId(remoteName, site) {
  const prefix = sitePrefix(site);
  const name = String(remoteName);
  if (!name.startsWith(prefix) || !name.endsWith('.zip')) return null;
  const rest = name.slice(prefix.length, -4);
  const sep = rest.lastIndexOf('--');
  const id = sep === -1 ? rest : rest.slice(sep + 2);
  return /^[A-Za-z0-9]+$/.test(id) ? id : null;
}

async function uploadBackup(store, site, backupId, providerId, onProgress) {
  const provider = getProvider(providerId);
  const backup = backups.findBackup(store, backupId);
  if (!backup) throw new Error('That backup no longer exists.');
  const remoteName = remoteNameFor(site, backup);
  await provider.upload(store, backup.file, remoteName, onProgress);
  return backups.updateBackupMeta(store, backupId, {
    uploads: {
      ...(backup.uploads || {}),
      [providerId]: { remoteName, uploadedAt: new Date().toISOString() },
    },
  });
}

async function listRemoteBackups(store, site, providerId) {
  const provider = getProvider(providerId);
  const local = new Set(backups.listBackups(store, site.id).map((b) => b.id));
  return (await provider.list(store, sitePrefix(site))).map((f) => ({
    ...f,
    backupId: parseRemoteBackupId(f.name, site),
    existsLocally: local.has(parseRemoteBackupId(f.name, site)),
  }));
}

// Downloads a remote archive back into the site's local backups dir and
// records it, so restore then goes through the normal local path.
async function downloadRemoteBackup(store, site, providerId, remoteName, onProgress) {
  const provider = getProvider(providerId);
  const progress = onProgress || (() => {});
  progress({ step: 'download', message: `Downloading ${remoteName}...` });

  const id = parseRemoteBackupId(remoteName, site) || wordpress.generateId();
  // Re-downloading a backup that still has a local record refreshes its
  // existing archive in place; otherwise the local file takes the exact name
  // it has in the cloud (the IPC handler already rejected path-y names).
  const existing = backups.findBackup(store, id);
  const file =
    existing?.file || path.join(backups.getBackupsDir(site.id), remoteName);
  await provider.download(store, remoteName, file);
  if (existing) return existing;

  const meta = {
    id,
    siteId: site.id,
    createdAt: new Date().toISOString(),
    sizeBytes: fs.statSync(file).size,
    note: `Downloaded from ${provider.name}`,
    trigger: 'cloud',
    wpVersion: 'unknown',
    phpVersion: site.phpVersion,
    file,
    uploads: { [providerId]: { remoteName, uploadedAt: new Date().toISOString() } },
  };
  store.set('backups', [...store.get('backups', []), meta]);
  progress({ step: 'done', message: 'Download complete.' });
  return meta;
}

// Remote retention mirrors the local retainCount: keep the newest N archives
// for this site, remove the rest. Best-effort — a cloud hiccup must never
// fail the backup that triggered it.
async function applyRemoteRetention(store, site, providerId) {
  const provider = getProvider(providerId);
  const retainCount = Math.max(1, store.get('settings.backups.retainCount', 5));
  try {
    const remote = (await provider.list(store, sitePrefix(site))).sort(
      (a, b) => new Date(b.modifiedAt || 0) - new Date(a.modifiedAt || 0)
    );
    for (const f of remote.slice(retainCount)) {
      await provider.remove(store, f.name);
    }
  } catch {}
}

module.exports = {
  getProvider,
  listProviders,
  getStatus,
  remoteNameFor,
  sitePrefix,
  parseRemoteBackupId,
  uploadBackup,
  listRemoteBackups,
  downloadRemoteBackup,
  applyRemoteRetention,
};
