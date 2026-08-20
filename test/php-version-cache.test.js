import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import brew from '../electron/services/brew.cjs';

// phpBinaryVersion memoises a process spawn, so the two things worth proving
// are that the cache actually saves the spawn and that it still notices when
// the binary changes underneath it — a cache that never invalidates would
// defeat the staleness check the function exists for (an `opt` symlink
// repointed by `brew upgrade`).
//
// The fixtures are shell scripts standing in for php binaries: each records
// that it ran, so "did this spawn?" is observable rather than assumed.
let dir;
let runLog;

const fakePhp = (file, version) => {
  fs.writeFileSync(
    file,
    `#!/bin/sh\necho run >> ${JSON.stringify(runLog)}\nprintf %s ${version}\n`
  );
  fs.chmodSync(file, 0o755);
};

const runCount = () =>
  fs.existsSync(runLog) ? fs.readFileSync(runLog, 'utf8').trim().split('\n').length : 0;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-phpver-'));
  runLog = path.join(dir, 'runs.log');
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('phpBinaryVersion caching', () => {
  it('reads the version by running the binary', () => {
    const bin = path.join(dir, 'php-a');
    fakePhp(bin, '8.3');
    expect(brew.phpBinaryVersion(bin)).toBe('8.3');
    expect(runCount()).toBe(1);
  });

  // The point of the cache: this probe used to cost ~45ms of blocked main
  // thread per call, once per installed version, on every window focus.
  it('serves repeat calls without spawning again', () => {
    const bin = path.join(dir, 'php-b');
    fakePhp(bin, '8.2');
    const before = runCount();
    expect(brew.phpBinaryVersion(bin)).toBe('8.2');
    expect(brew.phpBinaryVersion(bin)).toBe('8.2');
    expect(brew.phpBinaryVersion(bin)).toBe('8.2');
    expect(runCount()).toBe(before + 1);
  });

  // What `brew upgrade` looks like from here: same path, different binary.
  it('re-probes when the binary changes', () => {
    const bin = path.join(dir, 'php-c');
    fakePhp(bin, '8.4');
    expect(brew.phpBinaryVersion(bin)).toBe('8.4');

    fakePhp(bin, '8.5');
    // Same-second writes can land on an identical mtime; the size is unchanged
    // here too, so make the change unambiguous the way a real upgrade would.
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(bin, future, future);

    expect(brew.phpBinaryVersion(bin)).toBe('8.5');
  });

  it('returns null for a missing binary, and does not cache the miss', () => {
    const bin = path.join(dir, 'php-d');
    expect(brew.phpBinaryVersion(bin)).toBeNull();
    fakePhp(bin, '8.1');
    expect(brew.phpBinaryVersion(bin)).toBe('8.1');
  });

  it('returns null when the binary prints something that is not a version', () => {
    const bin = path.join(dir, 'php-e');
    fs.writeFileSync(bin, '#!/bin/sh\nprintf %s "not a version"\n');
    fs.chmodSync(bin, 0o755);
    expect(brew.phpBinaryVersion(bin)).toBeNull();
  });

  it('returns null when the binary exits non-zero', () => {
    const bin = path.join(dir, 'php-f');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(bin, 0o755);
    expect(brew.phpBinaryVersion(bin)).toBeNull();
  });
});
