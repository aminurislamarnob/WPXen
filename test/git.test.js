import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import git from '../electron/services/git.cjs';

const { parseStatus, parseNumstat, discoverRepos } = git;

describe('parseNumstat', () => {
  it('parses plain add/delete counts', () => {
    expect(parseNumstat('3\t1\tsrc/a.js\n0\t5\tb.txt')).toEqual({
      'src/a.js': { additions: 3, deletions: 1 },
      'b.txt': { additions: 0, deletions: 5 },
    });
  });

  it('treats binary "-" counts as zero', () => {
    expect(parseNumstat('-\t-\timg.png')).toEqual({
      'img.png': { additions: 0, deletions: 0 },
    });
  });

  it('keys brace-form renames off the new path', () => {
    expect(parseNumstat('2\t1\tsrc/{old.js => new.js}')).toEqual({
      'src/new.js': { additions: 2, deletions: 1 },
    });
  });

  it('keys plain-arrow renames off the new path', () => {
    expect(parseNumstat('0\t0\told.js => new.js')).toEqual({
      'new.js': { additions: 0, deletions: 0 },
    });
  });

  it('ignores blank and malformed lines', () => {
    expect(parseNumstat('\n5\tonly-two-cols\n')).toEqual({});
  });
});

describe('parseStatus', () => {
  it('parses a plain unstaged modification', () => {
    const files = parseStatus(' M a.js', { 'a.js': { additions: 2, deletions: 1 } }, {});
    expect(files).toEqual([
      {
        rel: 'a.js',
        name: 'a.js',
        oldRel: null,
        status: 'M',
        source: 'unstaged',
        additions: 2,
        deletions: 1,
      },
    ]);
  });

  it('splits a partially-staged file (MM) into staged + unstaged entries', () => {
    const files = parseStatus(
      'MM a.js',
      { 'a.js': { additions: 1, deletions: 0 } },
      { 'a.js': { additions: 4, deletions: 2 } }
    );
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      status: 'M',
      source: 'staged',
      additions: 4,
      deletions: 2,
    });
    expect(files[1]).toMatchObject({
      status: 'M',
      source: 'unstaged',
      additions: 1,
      deletions: 0,
    });
  });

  it('marks untracked files as unstaged with status "?"', () => {
    const files = parseStatus('?? new.php', {}, {});
    expect(files).toEqual([
      {
        rel: 'new.php',
        name: 'new.php',
        oldRel: null,
        status: '?',
        source: 'unstaged',
        additions: 0,
        deletions: 0,
      },
    ]);
  });

  it('captures the old path for a staged rename', () => {
    const files = parseStatus(
      'R  old.js -> new.js',
      {},
      { 'new.js': { additions: 0, deletions: 0 } }
    );
    expect(files).toEqual([
      {
        rel: 'new.js',
        name: 'new.js',
        oldRel: 'old.js',
        status: 'R',
        source: 'staged',
        additions: 0,
        deletions: 0,
      },
    ]);
  });

  it('unquotes paths with unusual bytes', () => {
    const files = parseStatus(
      ' M "a b.js"',
      { 'a b.js': { additions: 1, deletions: 0 } },
      {}
    );
    expect(files[0].rel).toBe('a b.js');
  });

  it('handles a staged addition', () => {
    const files = parseStatus(
      'A  added.txt',
      {},
      { 'added.txt': { additions: 7, deletions: 0 } }
    );
    expect(files[0]).toMatchObject({ status: 'A', source: 'staged', additions: 7 });
  });

  it('handles a staged deletion', () => {
    const files = parseStatus(
      'D  gone.txt',
      {},
      { 'gone.txt': { additions: 0, deletions: 9 } }
    );
    expect(files[0]).toMatchObject({ status: 'D', source: 'staged', deletions: 9 });
  });

  it('returns nothing for empty output', () => {
    expect(parseStatus('', {}, {})).toEqual([]);
  });

  it('falls back to zero counts when numstat lacks the file', () => {
    const files = parseStatus(' M orphan.js', {}, {});
    expect(files[0]).toMatchObject({ additions: 0, deletions: 0 });
  });
});

describe('discoverRepos', () => {
  let root;
  const mkGit = (p) => fs.mkdirSync(path.join(p, '.git'), { recursive: true });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-git-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns the root itself when it is a repo', () => {
    mkGit(root);
    expect(discoverRepos(root)).toEqual([path.resolve(root)]);
  });

  it('finds nested repos when the root is not a repo', () => {
    const theme = path.join(root, 'wp-content/themes/mytheme');
    const plugin = path.join(root, 'wp-content/plugins/myplugin');
    fs.mkdirSync(theme, { recursive: true });
    fs.mkdirSync(plugin, { recursive: true });
    mkGit(theme);
    mkGit(plugin);

    const found = discoverRepos(root).sort();
    expect(found).toEqual([path.resolve(plugin), path.resolve(theme)].sort());
  });

  it('does not descend into an ignored directory like node_modules', () => {
    const buried = path.join(root, 'node_modules/pkg');
    fs.mkdirSync(buried, { recursive: true });
    mkGit(buried);
    expect(discoverRepos(root)).toEqual([]);
  });

  it('stops descending once a repo is found (no repos within repos)', () => {
    const outer = path.join(root, 'project');
    const inner = path.join(outer, 'sub');
    fs.mkdirSync(inner, { recursive: true });
    mkGit(outer);
    mkGit(inner);
    expect(discoverRepos(root)).toEqual([path.resolve(outer)]);
  });

  it('returns nothing for a plain non-repo tree', () => {
    fs.mkdirSync(path.join(root, 'a/b/c'), { recursive: true });
    expect(discoverRepos(root)).toEqual([]);
  });
});

describe('parseGithubRemote', () => {
  const { parseGithubRemote } = git;

  it('reads owner/name from every github.com URL form', () => {
    for (const url of [
      'https://github.com/acme/shop-theme.git',
      'https://github.com/acme/shop-theme',
      'https://github.com/acme/shop-theme/',
      'https://token@github.com/acme/shop-theme.git',
      'git@github.com:acme/shop-theme.git',
      'git@github.com:acme/shop-theme',
      'ssh://git@github.com/acme/shop-theme.git',
      'ssh://git@github.com:22/acme/shop-theme',
    ]) {
      expect(parseGithubRemote(url)).toEqual({ owner: 'acme', name: 'shop-theme' });
    }
  });

  it('keeps dots in repo names', () => {
    expect(parseGithubRemote('git@github.com:acme/acme.github.io.git')).toEqual({
      owner: 'acme',
      name: 'acme.github.io',
    });
  });

  it('ignores other hosts and local paths', () => {
    for (const url of [
      'https://gitlab.com/acme/shop.git',
      'git@bitbucket.org:acme/shop.git',
      '/Users/me/repos/shop.git',
      'https://github.com/acme',
      '',
      null,
    ]) {
      expect(parseGithubRemote(url)).toBeNull();
    }
  });
});

describe('pickGithubRemote', () => {
  const { parseRemotes, pickGithubRemote } = git;
  const remotes = (lines) => parseRemotes(lines.join('\n'));

  it('prefers upstream over origin', () => {
    const r = remotes([
      'origin\tgit@github.com:me/shop.git (fetch)',
      'origin\tgit@github.com:me/shop.git (push)',
      'upstream\thttps://github.com/acme/shop.git (fetch)',
      'upstream\thttps://github.com/acme/shop.git (push)',
    ]);
    expect(pickGithubRemote(r)).toEqual({
      owner: 'acme',
      name: 'shop',
      remote: 'upstream',
    });
  });

  it('skips a non-GitHub upstream for a GitHub origin', () => {
    const r = remotes([
      'origin\tgit@github.com:me/shop.git (fetch)',
      'upstream\thttps://gitlab.com/acme/shop.git (fetch)',
    ]);
    expect(pickGithubRemote(r)).toMatchObject({ owner: 'me', remote: 'origin' });
  });

  it('falls back to any other GitHub remote', () => {
    expect(
      pickGithubRemote(remotes(['work\tgit@github.com:acme/shop.git (fetch)']))
    ).toEqual({
      owner: 'acme',
      name: 'shop',
      remote: 'work',
    });
  });

  it('is null with no GitHub remote', () => {
    expect(pickGithubRemote(remotes(['origin\t/srv/git/shop.git (fetch)']))).toBeNull();
    expect(pickGithubRemote({})).toBeNull();
  });
});

describe('githubReposFor', () => {
  let root;
  const sh = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-gh-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("finds the GitHub repos among a Site's nested repos", async () => {
    const theme = path.join(root, 'wp-content/themes/shop-theme');
    const plugin = path.join(root, 'wp-content/plugins/local-only');
    for (const dir of [theme, plugin]) {
      fs.mkdirSync(dir, { recursive: true });
      sh(dir, 'init', '-q');
    }
    sh(theme, 'remote', 'add', 'origin', 'git@github.com:acme/shop-theme.git');

    expect(await git.githubReposFor(root)).toEqual([
      {
        repoRoot: path.resolve(theme),
        owner: 'acme',
        name: 'shop-theme',
        remote: 'origin',
      },
    ]);
  });

  it('is empty for a Site with no repos', async () => {
    expect(await git.githubReposFor(root)).toEqual([]);
  });
});
