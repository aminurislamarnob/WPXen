import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { migrateLegacyUserData } from '../electron/services/rebrand.cjs';

let root;
let legacyDir;
let currentDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpdevpilot-rebrand-'));
  legacyDir = path.join(root, 'WPHerd');
  currentDir = path.join(root, 'WPDevPilot');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function seedLegacy(data = { sites: [{ domain: 'my-blog.test' }] }) {
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyDir, 'wpherd-data.json'),
    JSON.stringify(data),
    'utf8'
  );
}

describe('migrateLegacyUserData', () => {
  it('copies the old data file into the renamed userData directory', () => {
    seedLegacy();

    expect(migrateLegacyUserData({ legacyDir, currentDir })).toBe(true);

    const moved = JSON.parse(
      fs.readFileSync(path.join(currentDir, 'wpdevpilot-data.json'), 'utf8')
    );
    expect(moved.sites[0].domain).toBe('my-blog.test');
    // Copy, not move — a downgrade should still find its own data.
    expect(fs.existsSync(path.join(legacyDir, 'wpherd-data.json'))).toBe(true);
  });

  it('carries blueprints across', () => {
    seedLegacy();
    fs.mkdirSync(path.join(legacyDir, 'blueprints'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'blueprints', 'bp1.zip'), 'zip', 'utf8');

    migrateLegacyUserData({ legacyDir, currentDir });

    expect(fs.readFileSync(path.join(currentDir, 'blueprints', 'bp1.zip'), 'utf8')).toBe(
      'zip'
    );
  });

  it('never overwrites data the renamed app already has', () => {
    seedLegacy();
    fs.mkdirSync(currentDir, { recursive: true });
    fs.writeFileSync(
      path.join(currentDir, 'wpdevpilot-data.json'),
      JSON.stringify({ sites: [] }),
      'utf8'
    );

    expect(migrateLegacyUserData({ legacyDir, currentDir })).toBe(false);
    const kept = JSON.parse(
      fs.readFileSync(path.join(currentDir, 'wpdevpilot-data.json'), 'utf8')
    );
    expect(kept.sites).toEqual([]);
  });

  it('is a no-op with nothing to migrate', () => {
    expect(migrateLegacyUserData({ legacyDir, currentDir })).toBe(false);
    expect(fs.existsSync(currentDir)).toBe(false);
  });

  it('tolerates missing arguments', () => {
    expect(migrateLegacyUserData()).toBe(false);
  });
});
