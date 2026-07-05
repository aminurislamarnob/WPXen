import { describe, it, expect } from 'vitest';
import siteops from '../electron/services/siteops.cjs';

const site = {
  id: 'abc123',
  name: 'My Blog',
  domain: 'my-blog.test',
  url: 'https://my-blog.test',
  path: '/Users/dev/Sites/my-blog',
  phpVersion: '8.3',
  wpVersion: '6.8.2',
  dbName: 'my_blog_db',
  https: true,
  adminUser: 'admin',
  adminEmail: 'admin@my-blog.test',
};

describe('buildManifest / validateManifest', () => {
  it('round-trips a well-formed site', () => {
    const manifest = siteops.buildManifest(site, { tablePrefix: 'wp_' });
    expect(manifest.format).toBe('wpherd-site');
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.domain).toBe('my-blog.test');
    expect(manifest.https).toBe(true);
    expect(() => siteops.validateManifest(manifest)).not.toThrow();
    expect(siteops.validateManifest(manifest)).toBe(manifest);
  });

  it('defaults url and tablePrefix', () => {
    const m = siteops.buildManifest({ ...site, url: undefined });
    expect(m.url).toBe('http://my-blog.test');
    expect(m.tablePrefix).toBe('wp_');
  });

  it('rejects a foreign format', () => {
    expect(() => siteops.validateManifest({ format: 'other', formatVersion: 1 })).toThrow(
      /not exported by WPHerd/
    );
  });

  it('rejects a future format version', () => {
    expect(() =>
      siteops.validateManifest({ format: 'wpherd-site', formatVersion: 2, domain: 'a.test' })
    ).toThrow(/format version/);
  });

  it('rejects an invalid domain', () => {
    expect(() =>
      siteops.validateManifest({
        format: 'wpherd-site',
        formatVersion: 1,
        domain: 'bad domain.test',
      })
    ).toThrow(/invalid domain/);
  });

  it('rejects an unsafe table prefix', () => {
    expect(() =>
      siteops.validateManifest({
        format: 'wpherd-site',
        formatVersion: 1,
        domain: 'a.test',
        tablePrefix: 'wp`; DROP--',
      })
    ).toThrow(/table prefix/);
  });

  it('rejects non-objects', () => {
    expect(() => siteops.validateManifest(null)).toThrow(/not valid JSON/);
    expect(() => siteops.validateManifest('str')).toThrow(/not valid JSON/);
  });
});

describe('detectImportKind', () => {
  it('detects .wpress by extension', () => {
    expect(siteops.detectImportKind('.wpress', [])).toBe('wpress');
  });

  it('detects a WPHerd archive by manifest entry', () => {
    expect(
      siteops.detectImportKind('.zip', ['database.sql', 'wpherd-manifest.json', 'files/'])
    ).toBe('wpherd');
  });

  it('falls back to generic', () => {
    expect(siteops.detectImportKind('.zip', ['site/wp-settings.php', 'db.sql'])).toBe(
      'generic'
    );
  });

  it('does not match a nested manifest path', () => {
    expect(siteops.detectImportKind('.zip', ['files/wpherd-manifest.json'])).toBe('generic');
  });
});

describe('detectTablePrefix', () => {
  it('finds a custom prefix from CREATE TABLE options', () => {
    expect(siteops.detectTablePrefix('CREATE TABLE `xyz9_options` (\n  id int')).toBe('xyz9_');
  });

  it('finds the prefix from posts/users tables too', () => {
    expect(siteops.detectTablePrefix('CREATE TABLE `abc_posts` (')).toBe('abc_');
    expect(siteops.detectTablePrefix('CREATE TABLE abc_users (')).toBe('abc_');
  });

  it('returns null when nothing matches', () => {
    expect(siteops.detectTablePrefix('INSERT INTO nothing VALUES (1);')).toBeNull();
  });
});

describe('isMultisiteDump', () => {
  it('flags a real multisite dump (blogs + sitemeta + site)', () => {
    const head = [
      'CREATE TABLE `wp_blogs` (',
      'CREATE TABLE `wp_site` (',
      'CREATE TABLE `wp_sitemeta` (',
      'CREATE TABLE `wp_options` (',
    ].join('\n');
    expect(siteops.isMultisiteDump(head)).toBe(true);
  });

  it('does not flag a single-site dump whose plugin table ends in "blogs"', () => {
    const head = [
      'CREATE TABLE `wp_options` (',
      'CREATE TABLE `wp_userblogs` (',
      'CREATE TABLE `wp_user_blogs` (',
      'CREATE TABLE `wp_posts` (',
    ].join('\n');
    expect(siteops.isMultisiteDump(head)).toBe(false);
  });

  it('requires two distinct multisite tables (one is not enough)', () => {
    expect(siteops.isMultisiteDump('CREATE TABLE `wp_blogs` (')).toBe(false);
  });

  it('works with custom prefixes and unquoted names', () => {
    const head = 'CREATE TABLE my_blogs (\nCREATE TABLE my_sitemeta (';
    expect(siteops.isMultisiteDump(head)).toBe(true);
  });
});

describe('urlHost', () => {
  it('extracts the host from full URLs', () => {
    expect(siteops.urlHost('https://example.com/blog')).toBe('example.com');
    expect(siteops.urlHost('http://my-blog.test')).toBe('my-blog.test');
  });

  it('handles scheme-less values', () => {
    expect(siteops.urlHost('example.com')).toBe('example.com');
  });

  it('returns null for junk', () => {
    expect(siteops.urlHost('')).toBeNull();
    expect(siteops.urlHost(null)).toBeNull();
    expect(siteops.urlHost('not a url at all //')).toBeNull();
  });
});
