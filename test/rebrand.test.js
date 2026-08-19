import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { migrateLegacyUserData } from '../electron/services/rebrand.cjs';

let appDataDir;
let currentDir;

beforeEach(() => {
  appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-rebrand-'));
  currentDir = path.join(appDataDir, 'WPXen');
});

afterEach(() => {
  fs.rmSync(appDataDir, { recursive: true, force: true });
});

const GENERATIONS = {
  WPDevPilot: 'wpdevpilot-data.json',
  WPHerd: 'wpherd-data.json',
};

function seedLegacy(dir, data = { sites: [{ domain: 'my-blog.test' }] }) {
  const legacyDir = path.join(appDataDir, dir);
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, GENERATIONS[dir]), JSON.stringify(data), 'utf8');
  return legacyDir;
}

describe('migrateLegacyUserData', () => {
  it.each(Object.keys(GENERATIONS))(
    'copies a %s data file into the renamed userData directory',
    (dir) => {
      const legacyDir = seedLegacy(dir);

      expect(migrateLegacyUserData({ appDataDir, currentDir })).toBe(true);

      const moved = JSON.parse(
        fs.readFileSync(path.join(currentDir, 'wpxen-data.json'), 'utf8')
      );
      expect(moved.sites[0].domain).toBe('my-blog.test');
      // Copy, not move — a downgrade should still find its own data.
      expect(fs.existsSync(path.join(legacyDir, GENERATIONS[dir]))).toBe(true);
    }
  );

  it('prefers the newest generation when several are present', () => {
    seedLegacy('WPHerd', { sites: [{ domain: 'oldest.test' }] });
    seedLegacy('WPDevPilot', { sites: [{ domain: 'newest.test' }] });

    expect(migrateLegacyUserData({ appDataDir, currentDir })).toBe(true);

    const moved = JSON.parse(
      fs.readFileSync(path.join(currentDir, 'wpxen-data.json'), 'utf8')
    );
    expect(moved.sites[0].domain).toBe('newest.test');
  });

  it('carries blueprints across', () => {
    const legacyDir = seedLegacy('WPDevPilot');
    fs.mkdirSync(path.join(legacyDir, 'blueprints'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'blueprints', 'bp1.zip'), 'zip', 'utf8');

    migrateLegacyUserData({ appDataDir, currentDir });

    expect(fs.readFileSync(path.join(currentDir, 'blueprints', 'bp1.zip'), 'utf8')).toBe(
      'zip'
    );
  });

  it('never overwrites data the renamed app already has', () => {
    seedLegacy('WPDevPilot');
    fs.mkdirSync(currentDir, { recursive: true });
    fs.writeFileSync(
      path.join(currentDir, 'wpxen-data.json'),
      JSON.stringify({ sites: [] }),
      'utf8'
    );

    expect(migrateLegacyUserData({ appDataDir, currentDir })).toBe(false);
    const kept = JSON.parse(
      fs.readFileSync(path.join(currentDir, 'wpxen-data.json'), 'utf8')
    );
    expect(kept.sites).toEqual([]);
  });

  it('is a no-op with nothing to migrate', () => {
    expect(migrateLegacyUserData({ appDataDir, currentDir })).toBe(false);
    expect(fs.existsSync(currentDir)).toBe(false);
  });

  it('tolerates missing arguments', () => {
    expect(migrateLegacyUserData()).toBe(false);
  });
});
