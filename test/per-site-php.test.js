import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

// Loaded through Node's require on purpose: an ESM `import` of a .cjs file
// gets its own instance under vitest, so stubbing it wouldn't reach the copy
// that nginx.cjs / wordpress.cjs `require` internally.
const require = createRequire(import.meta.url);
const brew = require('../electron/services/brew.cjs');
const php = require('../electron/services/php.cjs');
const nginx = require('../electron/services/nginx.cjs');
const wordpress = require('../electron/services/wordpress.cjs');
const migration = require('../electron/services/migration.cjs');

// The other half of per-site PHP: that a Site is actually *pointed* at its
// version — its vhost, the one-time rewrite of pre-existing vhosts, and the
// PHP that WP-CLI runs with for it.
//
// CI has no Homebrew, so the prefix (and which kegs exist) are stood in by
// replacing the module exports the code under test calls through.

const PREFIX = '/opt/homebrew';
const saved = {};

beforeAll(() => {
  saved.getBrewPrefix = brew.getBrewPrefix;
  saved.getActivePhpVersion = brew.getActivePhpVersion;
  saved.phpKegDir = php.phpKegDir;
  saved.getPhpBinPath = php.getPhpBinPath;
  brew.getBrewPrefix = () => PREFIX;
  brew.getActivePhpVersion = () => '8.5';
  php.phpKegDir = (v) => `${PREFIX}/opt/php@${v}`;
  php.getPhpBinPath = (v) => `${PREFIX}/opt/php@${v}/bin/php`;
});

afterAll(
  () =>
    Object.assign(brew, {
      getBrewPrefix: saved.getBrewPrefix,
      getActivePhpVersion: saved.getActivePhpVersion,
    }) &&
    Object.assign(php, { phpKegDir: saved.phpKegDir, getPhpBinPath: saved.getPhpBinPath })
);

const site = (over = {}) => ({
  name: 'Shop',
  domain: 'shop.test',
  path: '/Users/me/Sites/shop',
  phpVersion: '8.4',
  ...over,
});

describe('vhost', () => {
  it("sends PHP to the Site's own version socket", () => {
    const conf = nginx.generateSiteConfig(site());
    expect(conf).toContain(`fastcgi_pass unix:${PREFIX}/var/run/wpxen/php8.4.sock;`);
    expect(conf).not.toContain('127.0.0.1:9000');
  });

  it('gives two Sites on different versions different sockets', () => {
    const a = nginx.generateSiteConfig(site({ phpVersion: '8.3' }));
    const b = nginx.generateSiteConfig(site({ phpVersion: '8.5', domain: 'b.test' }));
    expect(a).toContain('php8.3.sock');
    expect(b).toContain('php8.5.sock');
  });

  it('runs a Site with no recorded version on the active one', () => {
    expect(nginx.generateSiteConfig(site({ phpVersion: undefined }))).toContain(
      'php8.5.sock'
    );
  });
});

describe('migrateToPerSitePhp', () => {
  const makeStore = (data) => ({
    data,
    get(k, d) {
      return k in this.data ? this.data[k] : d;
    },
    set(k, v) {
      this.data[k] = v;
    },
  });

  const makeDeps = () => {
    const log = [];
    return {
      log,
      deps: {
        nginx: {
          createSiteConfig: (s) => log.push(`vhost ${s.domain}`),
          reload: () => log.push('reload'),
        },
        procman: { stop: async (n) => log.push(`stop ${n}`) },
        phpmyadmin: { hasVhost: () => true, ensureVhost: () => log.push('vhost pma') },
      },
    };
  };

  it('rewrites every vhost, phpMyAdmin included, once', async () => {
    const store = makeStore({ sites: [site(), site({ domain: 'b.test' })] });
    const { log, deps } = makeDeps();
    expect(await migration.migrateToPerSitePhp(store, deps)).toMatchObject({
      migrated: true,
    });
    expect(log).toEqual([
      'stop php',
      'vhost shop.test',
      'vhost b.test',
      'vhost pma',
      'reload',
    ]);

    const again = makeDeps();
    expect(await migration.migrateToPerSitePhp(store, again.deps)).toEqual({
      migrated: false,
    });
    expect(again.log).toEqual([]);
  });

  it('carries on past a Site whose vhost will not write, and reports it', async () => {
    const store = makeStore({ sites: [site({ domain: 'bad.test' }), site()] });
    const { log, deps } = makeDeps();
    deps.nginx.createSiteConfig = (s) => {
      if (s.domain === 'bad.test') throw new Error('nope');
      log.push(`vhost ${s.domain}`);
    };
    const res = await migration.migrateToPerSitePhp(store, deps);
    expect(res.failed).toEqual([{ domain: 'bad.test', error: 'nope' }]);
    expect(log).toContain('vhost shop.test');
    expect(store.get(migration.PER_SITE_PHP_FLAG)).toBe(true);
  });
});

describe('WP-CLI PHP', () => {
  const shop = '/Users/me/Sites/shop';

  it("uses a saved Site's version, found by path — also from a subdirectory", () => {
    wordpress.setSitePhpLookup((dir) => (dir.startsWith(shop) ? '8.3' : null));
    expect(wordpress.wpRuntime(shop).phpBin).toBe(`${PREFIX}/opt/php@8.3/bin/php`);
    expect(wordpress.wpRuntime(path.join(shop, 'wp-content')).phpBin).toContain(
      'php@8.3'
    );
  });

  it("puts that version's bin first on PATH", () => {
    wordpress.setSitePhpLookup(() => '8.3');
    expect(wordpress.wpRuntime(shop).env.PATH.split(':')[0]).toBe(
      `${PREFIX}/opt/php@8.3/bin`
    );
  });

  it('uses a pinned version for a Site that is not saved yet, until unpinned', () => {
    wordpress.setSitePhpLookup(() => null);
    const unpin = wordpress.pinSitePhp('/Users/me/Sites/new', '8.4');
    expect(wordpress.wpRuntime('/Users/me/Sites/new').phpBin).toContain('php@8.4');
    unpin();
    expect(wordpress.wpRuntime('/Users/me/Sites/new').phpBin).toBe(`${PREFIX}/bin/php`);
  });

  it('falls back to the active php outside any Site', () => {
    wordpress.setSitePhpLookup(() => null);
    expect(wordpress.wpRuntime('/tmp').phpBin).toBe(`${PREFIX}/bin/php`);
  });
});
