'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class JsonStore {
  constructor(name = 'config') {
    this.filePath = path.join(app.getPath('userData'), `${name}.json`);
    this.data = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      }
    } catch (err) {
      // Corrupted file — preserve it for diagnosis instead of silently losing
      // the user's data, then start fresh.
      try {
        fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {}
      console.error('Store load error (backed up corrupt file):', err);
    }
    return {};
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // Atomic write: serialize to a temp file, then rename over the target.
      // rename(2) is atomic on the same filesystem, so a crash mid-write can
      // never leave a half-written (corrupt) store behind.
      const tmpPath = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.error('Store save error:', err);
    }
  }

  get(key, defaultValue = undefined) {
    if (!key) return this.data;
    const value = key.split('.').reduce((obj, k) => obj?.[k], this.data);
    return value !== undefined ? value : defaultValue;
  }

  set(key, value) {
    const keys = key.split('.');
    let obj = this.data;
    for (let i = 0; i < keys.length - 1; i++) {
      if (typeof obj[keys[i]] !== 'object' || obj[keys[i]] === null) {
        obj[keys[i]] = {};
      }
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = value;
    this._save();
  }

  delete(key) {
    const keys = key.split('.');
    let obj = this.data;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!obj[keys[i]]) return;
      obj = obj[keys[i]];
    }
    delete obj[keys[keys.length - 1]];
    this._save();
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  getAll() {
    return { ...this.data };
  }
}

module.exports = JsonStore;
