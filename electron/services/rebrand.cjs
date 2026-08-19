'use strict';

const fs = require('fs');
const path = require('path');

// One-time carry-over of user data across the app's renames
// (WPHerd → WPDevPilot → WPXen).
//
// Renaming the app moves `userData` — Electron derives it from productName, so
// a rebranded build looks at ~/Library/Application Support/WPXen and finds
// nothing, and every site, setting and blueprint appears to have vanished. This
// copies (never moves) the user-meaningful state out of the newest old
// directory that still has data. Caches, logs, pid files and the browser
// partition are deliberately left behind — they rebuild themselves.
//
// Generations are tried newest-first and the first hit wins, so someone who
// skipped a release entirely — WPHerd straight to WPXen — is carried over just
// the same as someone who upgraded through every name.
//
// Pure fs + path so the module stays importable outside Electron: the caller
// supplies the directories.

const DATA_FILE = 'wpxen-data.json';
// Newest first. `dir` is relative to the platform's appData directory.
const LEGACY_GENERATIONS = [
  { dir: 'WPDevPilot', dataFile: 'wpdevpilot-data.json' },
  { dir: 'WPHerd', dataFile: 'wpherd-data.json' },
];
const CARRIED_DIRS = ['blueprints'];

// Copies one generation's data into currentDir. Returns false when there is
// nothing to copy, so the caller can fall through to an older generation.
function migrateOneGeneration({ legacyDir, currentDir, legacyDataFile, dataFile }) {
  const target = path.join(currentDir, dataFile);
  const source = path.join(legacyDir, legacyDataFile);
  // Already migrated, or already running with its own data — leave it alone.
  if (fs.existsSync(target) || !fs.existsSync(source)) return false;

  try {
    fs.mkdirSync(currentDir, { recursive: true });
    fs.copyFileSync(source, target);
  } catch (err) {
    console.error('Legacy data migration failed:', err);
    return false;
  }

  for (const dir of CARRIED_DIRS) {
    const from = path.join(legacyDir, dir);
    const to = path.join(currentDir, dir);
    try {
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.cpSync(from, to, { recursive: true });
      }
    } catch (err) {
      // A missed blueprint isn't worth failing the launch over.
      console.error(`Legacy ${dir} migration failed:`, err);
    }
  }

  return true;
}

function migrateLegacyUserData({
  appDataDir,
  currentDir,
  generations = LEGACY_GENERATIONS,
  dataFile = DATA_FILE,
} = {}) {
  if (!appDataDir || !currentDir) return false;
  // A store of our own already exists — nothing to carry over, and checking
  // every generation would only risk clobbering it.
  if (fs.existsSync(path.join(currentDir, dataFile))) return false;

  for (const gen of generations) {
    const migrated = migrateOneGeneration({
      legacyDir: path.join(appDataDir, gen.dir),
      currentDir,
      legacyDataFile: gen.dataFile,
      dataFile,
    });
    if (migrated) return true;
  }
  return false;
}

module.exports = { migrateLegacyUserData, LEGACY_GENERATIONS, DATA_FILE };
