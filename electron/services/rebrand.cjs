'use strict';

const fs = require('fs');
const path = require('path');

// One-time carry-over from the WPHerd name to WPDevPilot.
//
// Renaming the app moves `userData` — Electron derives it from productName, so
// a rebranded build looks at ~/Library/Application Support/WPDevPilot and finds
// nothing, and every site, setting and blueprint appears to have vanished. This
// copies (never moves) the user-meaningful state out of the old directory the
// first time the renamed build starts. Caches, logs, pid files and the browser
// partition are deliberately left behind — they rebuild themselves.
//
// Pure fs + path so the module stays importable outside Electron: the caller
// supplies both directories.

const LEGACY_DATA_FILE = 'wpherd-data.json';
const DATA_FILE = 'wpdevpilot-data.json';
const CARRIED_DIRS = ['blueprints'];

function migrateLegacyUserData({
  legacyDir,
  currentDir,
  legacyDataFile = LEGACY_DATA_FILE,
  dataFile = DATA_FILE,
} = {}) {
  if (!legacyDir || !currentDir) return false;

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

module.exports = { migrateLegacyUserData, LEGACY_DATA_FILE, DATA_FILE };
