'use strict';

const fs = require('fs');
const path = require('path');
const siteops = require('./siteops.cjs');
const wordpress = require('./wordpress.cjs');

// Blueprints are full site snapshots: a saved WPDevPilot export archive plus a
// metadata record. Archives live at userData/blueprints/{id}.zip; the metadata
// list lives in the store under the 'blueprints' key. Creating a site from a
// blueprint is just an import of its archive, so AddSiteModal reuses the
// site-create-progress channel and the import engine's rollback safety.

function getBlueprintsDir() {
  const { app } = require('electron');
  const dir = path.join(app.getPath('userData'), 'blueprints');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Exports `site` into a new blueprint archive and records its metadata.
async function saveBlueprint(store, { site, name, description }, onProgress) {
  const id = wordpress.generateId();
  const file = path.join(getBlueprintsDir(), `${id}.zip`);
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
    name: (name || site.name || 'Blueprint').trim(),
    description: (description || '').trim(),
    createdAt: new Date().toISOString(),
    sourceSiteName: site.name,
    phpVersion: site.phpVersion,
    wpVersion: site.wpVersion || 'unknown',
    sizeBytes,
    file,
  };
  store.set('blueprints', [...store.get('blueprints', []), meta]);
  return meta;
}

// Returns the blueprints whose archive still exists, healing the store of any
// orphaned records (file deleted out from under us).
function listBlueprints(store) {
  const list = store.get('blueprints', []);
  const healed = list.filter((b) => b && b.file && fs.existsSync(b.file));
  if (healed.length !== list.length) {
    store.set('blueprints', healed);
  }
  return healed;
}

function deleteBlueprint(store, id) {
  const list = store.get('blueprints', []);
  const bp = list.find((b) => b.id === id);
  if (bp && bp.file) {
    try {
      fs.rmSync(bp.file, { force: true });
    } catch {}
  }
  store.set(
    'blueprints',
    list.filter((b) => b.id !== id)
  );
  return true;
}

// Materializes a new site from a blueprint's archive. `target` is validated by
// the IPC handler exactly like an import.
async function createSiteFromBlueprint(store, id, target, onProgress) {
  const bp = listBlueprints(store).find((b) => b.id === id);
  if (!bp) throw new Error('That blueprint no longer exists.');
  return siteops.importSite(bp.file, target, onProgress);
}

module.exports = {
  getBlueprintsDir,
  saveBlueprint,
  listBlueprints,
  deleteBlueprint,
  createSiteFromBlueprint,
};
