import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  repoNameFromUrl,
  cloneTarget,
  parseProgress,
  cloneErrorMessage,
} = require('../electron/services/gitClone.cjs');

describe('repoNameFromUrl', () => {
  it('takes the last segment and drops .git', () => {
    expect(repoNameFromUrl('https://github.com/user/repo.git')).toBe('repo');
    expect(repoNameFromUrl('https://github.com/user/repo')).toBe('repo');
    expect(repoNameFromUrl('https://github.com/user/repo/')).toBe('repo');
    expect(repoNameFromUrl('git@github.com:user/my-repo.git')).toBe('my-repo');
    expect(repoNameFromUrl('git@host:repo.git')).toBe('repo');
    expect(repoNameFromUrl('/local/path/proj')).toBe('proj');
  });

  it('refuses names that would leave the parent folder', () => {
    expect(repoNameFromUrl('https://host/..')).toBeNull();
    expect(repoNameFromUrl('https://host/.')).toBeNull();
    expect(repoNameFromUrl('')).toBeNull();
  });
});

describe('cloneTarget', () => {
  it('joins the parent and repo name', () => {
    expect(cloneTarget('https://github.com/u/r.git', '/Users/me/Projects')).toBe(
      '/Users/me/Projects/r'
    );
  });

  it('rejects a missing or relative parent', () => {
    expect(() => cloneTarget('https://github.com/u/r', '')).toThrow(/parent folder/);
    expect(() => cloneTarget('https://github.com/u/r', 'Projects')).toThrow(
      /parent folder/
    );
  });

  it('rejects option-looking and ext:: URLs', () => {
    expect(() => cloneTarget('--upload-pack=touch /tmp/x', '/tmp')).toThrow();
    expect(() => cloneTarget('ext::sh -c touch% /tmp/x', '/tmp')).toThrow(/ext::/);
    expect(() => cloneTarget('  ', '/tmp')).toThrow(/Git URL/);
  });

  it('rejects a URL with no usable folder name', () => {
    expect(() => cloneTarget('https://host/..', '/tmp')).toThrow(/folder name/);
  });
});

describe('parseProgress', () => {
  it('returns the last phase and percent in a chunk', () => {
    const chunk =
      'Receiving objects:  10% (1/10)\rReceiving objects:  42% (4/10), 1.2 MiB | 2 MiB/s\r';
    expect(parseProgress(chunk)).toEqual({ phase: 'Receiving objects', percent: 42 });
  });

  it('reads remote-side phases', () => {
    expect(parseProgress('remote: Counting objects:  75% (3/4)')).toEqual({
      phase: 'Counting objects',
      percent: 75,
    });
  });

  it('ignores lines with no percent', () => {
    expect(parseProgress("Cloning into 'repo'...\n")).toBeNull();
  });
});

describe('cloneErrorMessage', () => {
  it('picks the fatal line', () => {
    const err =
      "Cloning into 'x'...\nremote: Repository not found.\nfatal: repository 'https://github.com/u/x/' not found\n";
    expect(cloneErrorMessage(err)).toBe("repository 'https://github.com/u/x/' not found");
  });

  it('explains a credential prompt', () => {
    expect(
      cloneErrorMessage(
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
      )
    ).toMatch(/credentials/);
  });

  it('falls back to the last line', () => {
    expect(cloneErrorMessage('something odd\n')).toBe('something odd');
    expect(cloneErrorMessage('')).toBe('unknown error');
  });
});

describe('stopAll', () => {
  it('resolves straight away when no clone is running', async () => {
    const { stopAll } = require('../electron/services/gitClone.cjs');
    await expect(stopAll()).resolves.toBeUndefined();
  });
});
