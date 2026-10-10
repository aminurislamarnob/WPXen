import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import files from '../electron/services/files.cjs';

describe('files.listFiles (chat @ mentions)', () => {
  let root;
  const write = (rel, body = '') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('lists a git repo through git, honouring .gitignore, without blocking', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-ls-git-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    write('.gitignore', 'secret.log\n');
    write('wp-config.php');
    write('wp-content/themes/shop/style.css');
    write('secret.log');

    const pending = files.listFiles(root);
    expect(pending).toBeInstanceOf(Promise);
    expect((await pending).sort()).toEqual([
      '.gitignore',
      'wp-config.php',
      'wp-content/themes/shop/style.css',
    ]);
  });

  it('walks a plain folder, skipping uploads and dependency folders', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-ls-dir-'));
    write('index.php');
    write('wp-content/uploads/2026/photo.jpg');
    write('node_modules/x/index.js');
    write('wp-content/plugins/shop/shop.php');

    expect((await files.listFiles(root)).sort()).toEqual([
      'index.php',
      'wp-content/plugins/shop/shop.php',
    ]);
  });
});
