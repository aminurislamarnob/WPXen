import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The one-time upgrade pass that brings Sites created before an app update up
// to the current vhost template — for #207, the shared error-page snippet.
// Collaborators are injected the way migrateToPerSitePhp's are, so nothing
// here touches nginx or the Homebrew prefix.
const require = createRequire(import.meta.url);
const migration = require('../electron/services/migration.cjs');
const brew = require('../electron/services/brew.cjs');
const nginx = require('../electron/services/nginx.cjs');

const makeStore = (data) => ({
  data,
  get(k, d) {
    return k in this.data ? this.data[k] : d;
  },
  set(k, v) {
    this.data[k] = v;
  },
});

const site = (over = {}) => ({ name: 'shop', domain: 'shop.test', ...over });

// Every collaborator call lands in one ordered log, so a test can assert what
// was written, in which order, and how many times nginx was reloaded.
const makeDeps = ({ pma = true } = {}) => {
  const log = [];
  return {
    log,
    deps: {
      nginx: {
        ensureErrorPages: () => {
          log.push('pages');
          return { snippetPath: '/opt/homebrew/etc/nginx/wpxen/wpxen-errors.conf' };
        },
        createSiteConfig: (s) => log.push(`vhost ${s.domain}`),
        validateConfig: () => {
          log.push('test');
          return { valid: true };
        },
        reload: () => log.push('reload'),
      },
      phpmyadmin: {
        DOMAIN: 'phpmyadmin.test',
        hasVhost: () => pma,
        writeVhost: () => log.push('vhost pma'),
      },
    },
  };
};

const reloads = (log) => log.filter((l) => l === 'reload').length;

describe('runSiteUpgrades — the error-page pass', () => {
  it('writes the snippet first, regenerates every vhost, tests nginx and reloads once', async () => {
    const store = makeStore({
      sites: [site(), site({ domain: 'b.test' }), site({ domain: 'c.test' })],
    });
    const { log, deps } = makeDeps();
    const res = await migration.runSiteUpgrades(store, deps);

    expect(res).toMatchObject({ migrated: true, failed: [] });
    expect(res.upgraded).toContain(migration.ERROR_PAGES_FLAG);
    expect(log).toEqual([
      'pages',
      'vhost shop.test',
      'vhost b.test',
      'vhost c.test',
      'vhost pma',
      'test',
      'reload',
    ]);
    expect(store.get(migration.ERROR_PAGES_FLAG)).toBe(true);
  });

  it('runs once: a second launch regenerates nothing', async () => {
    const store = makeStore({ sites: [site()] });
    await migration.runSiteUpgrades(store, makeDeps().deps);

    const again = makeDeps();
    expect(await migration.runSiteUpgrades(store, again.deps)).toEqual({
      migrated: false,
    });
    expect(again.log).toEqual([]);
    expect(migration.pendingSiteUpgrades(store)).toEqual([]);
  });

  it('reports a Site whose vhost fails and still updates the others', async () => {
    const store = makeStore({
      sites: [site({ domain: 'bad.test' }), site(), site({ domain: 'b.test' })],
    });
    const { log, deps } = makeDeps();
    deps.nginx.createSiteConfig = (s) => {
      if (s.domain === 'bad.test') throw new Error('nope');
      log.push(`vhost ${s.domain}`);
    };
    const res = await migration.runSiteUpgrades(store, deps);

    expect(res.migrated).toBe(true);
    expect(res.failed).toEqual([{ domain: 'bad.test', error: 'nope' }]);
    expect(log).toContain('vhost shop.test');
    expect(log).toContain('vhost b.test');
    expect(reloads(log)).toBe(1);
    // A per-Site failure is reported, not retried every launch: the launch-time
    // vhost rewrite keeps trying it.
    expect(store.get(migration.ERROR_PAGES_FLAG)).toBe(true);
  });

  it('reloads nginx once with phpMyAdmin present, and leaves it alone when absent', async () => {
    const store = makeStore({ sites: [site()] });
    const withPma = makeDeps({ pma: true });
    await migration.runSiteUpgrades(store, withPma.deps);
    expect(withPma.log).toContain('vhost pma');
    expect(reloads(withPma.log)).toBe(1);

    const fresh = makeStore({ sites: [site()] });
    const noPma = makeDeps({ pma: false });
    await migration.runSiteUpgrades(fresh, noPma.deps);
    expect(noPma.log).not.toContain('vhost pma');
    expect(reloads(noPma.log)).toBe(1);
  });

  it('reports a phpMyAdmin vhost failure alongside the Sites', async () => {
    const store = makeStore({ sites: [site()] });
    const { log, deps } = makeDeps();
    deps.phpmyadmin.writeVhost = () => {
      throw new Error('no phpMyAdmin dir');
    };
    const res = await migration.runSiteUpgrades(store, deps);
    expect(res.failed).toEqual([
      { domain: 'phpmyadmin.test', error: 'no phpMyAdmin dir' },
    ]);
    expect(log).toContain('vhost shop.test');
    expect(reloads(log)).toBe(1);
  });

  it('writes no vhost and keeps the flag unset when the snippet cannot be written', async () => {
    const store = makeStore({ sites: [site()] });
    const { log, deps } = makeDeps();
    deps.nginx.ensureErrorPages = () => {
      throw new Error('EACCES');
    };
    const res = await migration.runSiteUpgrades(store, deps);

    expect(res).toMatchObject({ migrated: false, error: 'EACCES' });
    expect(log).toEqual([]);
    expect(store.get(migration.ERROR_PAGES_FLAG, false)).toBe(false);
  });

  it('treats a missing nginx config folder as a failure, not a no-op', async () => {
    const store = makeStore({ sites: [site()] });
    const { log, deps } = makeDeps();
    deps.nginx.ensureErrorPages = () => null;
    const res = await migration.runSiteUpgrades(store, deps);
    expect(res.migrated).toBe(false);
    expect(res.error).toMatch(/nginx/);
    expect(log).toEqual([]);
    expect(store.get(migration.ERROR_PAGES_FLAG, false)).toBe(false);
  });

  it('does not reload or set the flag when nginx -t fails, and retries next launch', async () => {
    const store = makeStore({ sites: [site()] });
    const { log, deps } = makeDeps();
    deps.nginx.validateConfig = () => {
      log.push('test');
      return { valid: false, error: 'unknown directive' };
    };
    const res = await migration.runSiteUpgrades(store, deps);

    expect(res.migrated).toBe(false);
    expect(res.error).toContain('unknown directive');
    expect(reloads(log)).toBe(0);
    expect(migration.pendingSiteUpgrades(store)).toEqual([migration.ERROR_PAGES_FLAG]);

    const again = makeDeps();
    expect((await migration.runSiteUpgrades(store, again.deps)).migrated).toBe(true);
    expect(again.log).toContain('vhost shop.test');
    expect(store.get(migration.ERROR_PAGES_FLAG)).toBe(true);
  });

  it('with no vhosts to regenerate, writes the snippet and neither tests nor reloads nginx', async () => {
    const store = makeStore({ sites: [] });
    const { log, deps } = makeDeps({ pma: false });
    const res = await migration.runSiteUpgrades(store, deps);
    expect(res.migrated).toBe(true);
    expect(log).toEqual(['pages']);
    expect(store.get(migration.ERROR_PAGES_FLAG)).toBe(true);
  });

  it('lists the error-page pass as pending until it has run', () => {
    expect(migration.pendingSiteUpgrades(makeStore({}))).toEqual([
      migration.ERROR_PAGES_FLAG,
    ]);
    expect(
      migration.pendingSiteUpgrades(makeStore({ [migration.ERROR_PAGES_FLAG]: true }))
    ).toEqual([]);
  });
});

describe('runSiteUpgrades — against the real vhost template', () => {
  it("leaves every existing Site's vhost including a snippet that is on disk", async () => {
    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-upgrade-'));
    const saved = {
      getBrewPrefix: brew.getBrewPrefix,
      getActivePhpVersion: brew.getActivePhpVersion,
    };
    brew.getBrewPrefix = () => prefix;
    brew.getActivePhpVersion = () => '8.4';
    try {
      const servers = path.join(prefix, 'etc/nginx/servers');
      fs.mkdirSync(servers, { recursive: true });
      const sites = ['shop.test', 'blog.test'].map((domain) => ({
        name: domain,
        domain,
        path: `/Users/me/Sites/${domain}`,
        phpVersion: '8.4',
      }));
      // Vhosts as an older release wrote them: no include line.
      for (const s of sites) {
        fs.writeFileSync(
          path.join(servers, `${s.domain}.conf`),
          'server { listen 80; }\n'
        );
      }

      const log = [];
      const res = await migration.runSiteUpgrades(makeStore({ sites }), {
        nginx: {
          ...nginx,
          validateConfig: () => ({ valid: true }),
          reload: () => log.push('reload'),
        },
        phpmyadmin: { DOMAIN: 'phpmyadmin.test', hasVhost: () => false },
      });

      expect(res).toMatchObject({ migrated: true, failed: [] });
      expect(log).toEqual(['reload']);
      for (const s of sites) {
        const conf = fs.readFileSync(path.join(servers, `${s.domain}.conf`), 'utf8');
        const included = conf.match(/include (\S+);/)[1];
        expect(included).toBe(`${prefix}/etc/nginx/wpxen/wpxen-errors.conf`);
        expect(fs.existsSync(included)).toBe(true);
      }
    } finally {
      Object.assign(brew, saved);
      fs.rmSync(prefix, { recursive: true, force: true });
    }
  });
});
