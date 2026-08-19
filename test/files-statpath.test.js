import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import files from '../electron/services/files.cjs';

describe('files.statPath', () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-statpath-'));
    fs.mkdirSync(path.join(root, 'wp-content'));
    fs.writeFileSync(path.join(root, 'wp-content', 'x.php'), '<?php');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('resolves a relative path inside the root', () => {
    const r = files.statPath(root, 'wp-content/x.php');
    expect(r.exists).toBe(true);
    expect(r.isDirectory).toBe(false);
    expect(r.resolved).toBe(path.join(root, 'wp-content', 'x.php'));
  });

  it('resolves an absolute path inside the root', () => {
    const r = files.statPath(root, path.join(root, 'wp-content', 'x.php'));
    expect(r.exists).toBe(true);
  });

  it('reports directories', () => {
    const r = files.statPath(root, 'wp-content');
    expect(r.exists).toBe(true);
    expect(r.isDirectory).toBe(true);
  });

  it('rejects a path outside the root', () => {
    expect(files.statPath(root, '/etc/hosts').exists).toBe(false);
  });

  it('rejects traversal escaping the root', () => {
    expect(files.statPath(root, '../../etc/hosts').exists).toBe(false);
  });

  it('returns exists:false for a missing file', () => {
    expect(files.statPath(root, 'wp-content/nope.php').exists).toBe(false);
  });

  it('never throws on garbage input', () => {
    expect(files.statPath(root, '').exists).toBe(false);
    expect(files.statPath(root, 'a\0b').exists).toBe(false);
  });
});
