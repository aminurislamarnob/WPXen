import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import projectIcon from '../electron/services/projectIcon.cjs';

// A project's sidebar icon: the WordPress Site Icon, Orca's repo icon order
// when the Site's folder is a GitHub repo, else the WordPress logo. WP-CLI and
// git remotes are faked; repo files are real files in a temp dir.

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

let dir;
let wpAnswer;
let remotes;
let now;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-icon-'));
  wpAnswer = async () => '';
  remotes = [];
  now = 1000;
  projectIcon.__setDeps({
    runWp: (...args) => wpAnswer(...args),
    remotes: async () => remotes,
    now: () => now,
  });
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const site = () => ({ id: 's1', path: dir });
const gitRepo = (urls) => {
  fs.mkdirSync(path.join(dir, '.git'));
  remotes = Object.entries(urls).map(([name, url]) => ({ name, url }));
};

describe('projectIcon', () => {
  it('uses the WordPress Site Icon when one is set', async () => {
    const file = path.join(dir, 'icon-64.png');
    fs.writeFileSync(file, PNG);
    wpAnswer = async (args) => (args[0] === 'eval' ? file : '');
    const icon = await projectIcon.projectIcon(site());
    expect(icon).toMatchObject({ type: 'image', source: 'site-icon' });
    expect(icon.src.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('falls back to the WordPress logo for a Site with no icon and no repo', async () => {
    expect(await projectIcon.projectIcon(site())).toEqual({ type: 'wordpress' });
  });

  it('gives a folder project a folder glyph, without asking WordPress', async () => {
    let asked = false;
    wpAnswer = async () => {
      asked = true;
      return '';
    };
    const folder = { id: 'folder-1', kind: 'folder', path: dir };
    expect(await projectIcon.projectIcon(folder)).toEqual({ type: 'folder' });
    expect(asked).toBe(false);
  });

  it("uses Orca's order for a Site that is itself a GitHub repo", async () => {
    gitRepo({ origin: 'git@github.com:acme/shop.git' });
    // 1. a conventional icon file
    fs.mkdirSync(path.join(dir, 'public'));
    fs.writeFileSync(path.join(dir, 'public/logo.png'), PNG);
    expect(await projectIcon.detectRepoIcon(dir)).toMatchObject({
      source: 'file',
      label: 'public/logo.png',
    });
    // 2. package.json homepage
    fs.rmSync(path.join(dir, 'public/logo.png'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      '{"homepage":"https://shop.example"}'
    );
    expect(await projectIcon.detectRepoIcon(dir)).toMatchObject({
      source: 'favicon',
      src: 'https://www.google.com/s2/favicons?domain=shop.example&sz=64',
    });
    // 3. the owner's avatar
    fs.rmSync(path.join(dir, 'package.json'));
    expect(await projectIcon.detectRepoIcon(dir)).toEqual({
      type: 'image',
      src: 'https://github.com/acme.png?size=64',
      source: 'github',
      label: 'acme/shop',
    });
  });

  it('finds an icon declared in index.html', async () => {
    gitRepo({ origin: 'https://github.com/acme/shop' });
    fs.mkdirSync(path.join(dir, 'public'));
    fs.writeFileSync(
      path.join(dir, 'public/brand.webp'),
      Buffer.from('RIFF0000WEBPVP8 ', 'ascii')
    );
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      '<head><link rel="stylesheet" href="x.css"><link rel="icon" href="/brand.webp"></head>'
    );
    expect(await projectIcon.detectRepoIcon(dir)).toMatchObject({
      source: 'file',
      label: 'public/brand.webp',
    });
  });

  it('prefers the Site Icon over the repo', async () => {
    gitRepo({ origin: 'git@github.com:acme/shop.git' });
    const file = path.join(dir, 'site-icon.png');
    fs.writeFileSync(file, PNG);
    wpAnswer = async () => file;
    expect((await projectIcon.projectIcon(site())).source).toBe('site-icon');
  });

  it('ignores a folder that is not a GitHub repo', async () => {
    expect(await projectIcon.detectRepoIcon(dir)).toBeNull();
    gitRepo({ origin: 'git@gitlab.com:acme/shop.git' });
    expect(await projectIcon.detectRepoIcon(dir)).toBeNull();
  });

  it('reads a same-name fork as its parent, a renamed fork as itself', () => {
    const origin = { owner: 'me', name: 'shop' };
    expect(
      projectIcon.githubAvatarSlug(origin, { owner: 'acme', name: 'shop' }).owner
    ).toBe('acme');
    expect(
      projectIcon.githubAvatarSlug(origin, { owner: 'acme', name: 'store' }).owner
    ).toBe('me');
    expect(projectIcon.githubAvatarSlug(origin, null).owner).toBe('me');
  });

  it('caches, and asks WordPress again soon after a failed lookup', async () => {
    let calls = 0;
    wpAnswer = async () => {
      calls += 1;
      throw new Error('Error establishing a database connection');
    };
    expect(await projectIcon.projectIcon(site())).toEqual({ type: 'wordpress' });
    await projectIcon.projectIcon(site());
    expect(calls).toBe(1);
    now += 31_000;
    await projectIcon.projectIcon(site());
    expect(calls).toBe(2);
  });

  it('keeps homepage favicons to real project sites', () => {
    expect(projectIcon.faviconUrlFromWebsite('https://github.com/acme/shop')).toBeNull();
    expect(projectIcon.faviconUrlFromWebsite('javascript:alert(1)')).toBeNull();
    expect(projectIcon.faviconUrlFromWebsite('shop.example')).toContain(
      'domain=shop.example'
    );
  });

  it('never resolves a declared icon outside the repo', () => {
    expect(projectIcon.iconHrefCandidates('../../secret.png', 'index.html')).toEqual([]);
    expect(projectIcon.iconHrefCandidates('/../../secret.png', 'index.html')).toEqual([]);
    expect(projectIcon.iconHrefCandidates('img/a.png', 'src/index.html')).toEqual([
      'src/img/a.png',
      'img/a.png',
      'public/img/a.png',
    ]);
    expect(
      projectIcon.extractIconHref('<link rel="icon" href="https://cdn/x.png">')
    ).toBeNull();
  });
});

describe('custom project icons', () => {
  const iconDir = () => path.join(dir, 'project-icons');

  it('puts a custom emoji ahead of every detected icon', async () => {
    const file = path.join(dir, 'site-icon.png');
    fs.writeFileSync(file, PNG);
    wpAnswer = async () => file;
    const icon = await projectIcon.projectIcon(
      { ...site(), icon: { type: 'emoji', emoji: '🔥' } },
      { iconDir: iconDir() }
    );
    expect(icon).toEqual({ type: 'emoji', emoji: '🔥', source: 'custom' });
  });

  it('stores an uploaded PNG or WebP as a file, and reads it back', async () => {
    const res = projectIcon.writeIconImage(iconDir(), 's1', PNG.toString('base64'));
    expect(res).toEqual({ file: 's1.png' });
    expect(fs.existsSync(path.join(iconDir(), 's1.png'))).toBe(true);
    const icon = await projectIcon.projectIcon(
      { ...site(), icon: { type: 'image', file: 's1.png' } },
      { iconDir: iconDir() }
    );
    expect(icon.source).toBe('custom');
    expect(icon.src.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('replaces the other format on a new upload, and removes both on reset', () => {
    const webp = Buffer.from('RIFF0000WEBPVP8 ', 'ascii').toString('base64');
    projectIcon.writeIconImage(iconDir(), 's1', PNG.toString('base64'));
    expect(projectIcon.writeIconImage(iconDir(), 's1', webp)).toEqual({
      file: 's1.webp',
    });
    expect(fs.readdirSync(iconDir())).toEqual(['s1.webp']);
    projectIcon.removeIconImages(iconDir(), 's1');
    expect(fs.readdirSync(iconDir())).toEqual([]);
  });

  it('refuses anything but a small PNG or WebP, by its bytes', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]).toString('base64');
    expect(projectIcon.writeIconImage(iconDir(), 's1', jpeg).error).toMatch(
      /PNG or WebP/
    );
    expect(projectIcon.writeIconImage(iconDir(), 's1', '').error).toMatch(/empty/);
    const huge = Buffer.concat([PNG, Buffer.alloc(300 * 1024)]).toString('base64');
    expect(projectIcon.writeIconImage(iconDir(), 's1', huge).error).toMatch(/256 KB/);
    expect(
      projectIcon.writeIconImage(iconDir(), '../x', PNG.toString('base64')).error
    ).toBe('Invalid site');
  });

  it('falls back to detection when the custom image is missing or the record is odd', async () => {
    const auto = await projectIcon.projectIcon(
      { ...site(), icon: { type: 'image', file: 'gone.png' } },
      { iconDir: iconDir() }
    );
    expect(auto).toEqual({ type: 'wordpress' });
    expect(
      projectIcon.sanitizeCustomIcon({ type: 'image', file: '../../etc/passwd' })
    ).toBeNull();
    expect(projectIcon.sanitizeCustomIcon({ type: 'lucide', name: 'X' })).toBeNull();
  });

  it('accepts a single emoji, not text', () => {
    expect(projectIcon.sanitizeCustomIcon({ type: 'emoji', emoji: ' 🛒 ' })).toEqual({
      type: 'emoji',
      emoji: '🛒',
    });
    expect(projectIcon.sanitizeCustomIcon({ type: 'emoji', emoji: '👩‍💻' })).not.toBeNull();
    expect(projectIcon.sanitizeCustomIcon({ type: 'emoji', emoji: 'abc' })).toBeNull();
    expect(projectIcon.sanitizeCustomIcon({ type: 'emoji', emoji: '' })).toBeNull();
    expect(projectIcon.sanitizeCustomIcon({ type: 'emoji', emoji: '<img>' })).toBeNull();
  });
});
