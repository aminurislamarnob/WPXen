import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import afterPack from '../scripts/fix-pty-permissions.cjs';

// node-pty 1.1.0's macOS prebuilds ship spawn-helper without the execute bit,
// which makes every terminal fail with "posix_spawnp failed.".

const { fixPtyPermissions } = afterPack;
const tmpDirs = [];

function fakeRoot(helpers) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-pty-'));
  tmpDirs.push(root);
  for (const rel of helpers) {
    const file = path.join(root, 'node_modules', 'node-pty', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    fs.chmodSync(file, 0o644);
  }
  return root;
}

const isExecutable = (root, rel) =>
  (fs.statSync(path.join(root, 'node_modules', 'node-pty', rel)).mode & 0o111) === 0o111;

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('fixPtyPermissions', () => {
  it('marks every darwin prebuild and a source build executable', () => {
    const helpers = [
      'prebuilds/darwin-arm64/spawn-helper',
      'prebuilds/darwin-x64/spawn-helper',
      'build/Release/spawn-helper',
    ];
    const root = fakeRoot(helpers);
    expect(fixPtyPermissions(root)).toBe(3);
    for (const rel of helpers) expect(isExecutable(root, rel)).toBe(true);
  });

  it('leaves non-darwin prebuilds alone and reports nothing found', () => {
    const root = fakeRoot(['prebuilds/linux-x64/spawn-helper']);
    expect(fixPtyPermissions(root)).toBe(0);
    expect(isExecutable(root, 'prebuilds/linux-x64/spawn-helper')).toBe(false);
  });
});

describe('afterPack', () => {
  const context = (appOutDir, platform = 'darwin') => ({
    electronPlatformName: platform,
    appOutDir,
    packager: { appInfo: { productFilename: 'WPXen' } },
  });

  it('fixes the helpers inside app.asar.unpacked', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-pack-'));
    tmpDirs.push(out);
    const unpacked = path.join(out, 'WPXen.app/Contents/Resources/app.asar.unpacked');
    const helper = path.join(
      unpacked,
      'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'
    );
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(helper, '');
    fs.chmodSync(helper, 0o644);

    await afterPack(context(out));
    expect(fs.statSync(helper).mode & 0o111).toBe(0o111);
  });

  it('fails a mac build that has no helper to fix', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-pack-'));
    tmpDirs.push(out);
    await expect(afterPack(context(out))).rejects.toThrow(/spawn-helper/);
  });

  it('skips other platforms', async () => {
    await expect(afterPack(context('/nonexistent', 'linux'))).resolves.toBeUndefined();
  });
});
