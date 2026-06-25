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
    } catch {
      // corrupted file — start fresh
    }
    return {};
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
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
