import { describe, it, expect, beforeEach } from 'vitest';
import repair from '../electron/services/repair.cjs';

// The repair the 502 page asks for: restart the PHP-FPM version of the Site
// the request's host names — that version only — with joined concurrent
// repairs and the app's own per-Site limit.

let restarts; // versions restarted, in order
let accepting; // version -> socket accepts after restart
let failing; // version -> error thrown by its restart
let gates; // version -> resolve() to let its restart finish
let clock;

const SITES = [
  { id: 'a', domain: 'shop.test', phpVersion: '8.4', aliases: ['x.trycloudflare.com'] },
  { id: 'b', domain: 'blog.test', phpVersion: '8.4' },
  { id: 'c', domain: 'old.test', phpVersion: '8.2' },
  { id: 'd', domain: 'legacy.test' }, // predates per-site PHP
];

const make = (over = {}) =>
  repair.createRepairer({
    sites: () => SITES,
    activePhpVersion: () => '8.3',
    restartFpm: (v) =>
      new Promise((resolve, reject) => {
        restarts.push(v);
        const finish = () => (failing[v] ? reject(new Error(failing[v])) : resolve());
        if (gates.hold) gates[v] = finish;
        else finish();
      }),
    fpmAccepts: async (v) => accepting[v] !== false,
    now: () => clock,
    ...over,
  });

beforeEach(() => {
  restarts = [];
  accepting = {};
  failing = {};
  gates = {};
  clock = 1_000_000;
});

describe('identifying the Site', () => {
  it('rejects a host that is no known Site', async () => {
    const r = make();
    expect(r.status('evil.test')).toBeNull();
    expect(await r.repair('evil.test')).toBeNull();
    expect(restarts).toEqual([]);
  });

  it("doesn't take a share-tunnel alias as the Site", async () => {
    const r = make();
    expect(r.status('x.trycloudflare.com')).toBeNull();
    expect(await r.repair('x.trycloudflare.com')).toBeNull();
    expect(restarts).toEqual([]);
  });

  // The vhost answers to `*.domain` (nginx.cjs), so a subdomain's 502 page
  // asks on the parent Site's behalf. Same Site, same limit: many subdomains
  // don't buy a hostile page more restarts.
  it('maps a subdomain to the Site whose vhost serves it', async () => {
    const r = make();
    expect(r.status('en.shop.test')).toMatchObject({ phpVersion: '8.4' });
    expect(r.status('a.b.old.test')).toMatchObject({ phpVersion: '8.2' });
    expect(await r.repair('en.shop.test')).toMatchObject({ state: 'healthy' });
    expect(restarts).toEqual(['8.4']);
  });

  it('prefers a Site at the exact subdomain over its parent, as nginx does', () => {
    const sites = [
      { domain: 'shop.test', phpVersion: '8.4' },
      { domain: 'blog.shop.test', phpVersion: '8.2' },
    ];
    expect(repair.siteForHost(sites, 'blog.shop.test')).toEqual({
      domain: 'blog.shop.test',
      phpVersion: '8.2',
    });
    expect(repair.siteForHost(sites, 'x.blog.shop.test')).toMatchObject({
      domain: 'blog.shop.test',
    });
    expect(repair.siteForHost(sites, 'en.shop.test')).toMatchObject({
      domain: 'shop.test',
    });
  });

  it('only matches a whole label, and never a share-tunnel subdomain', () => {
    expect(make().status('myshop.test')).toBeNull();
    expect(make().status('y.x.trycloudflare.com')).toBeNull();
  });

  it('matches the domain case-insensitively', () => {
    expect(make().status('Shop.TEST')).toMatchObject({ phpVersion: '8.4' });
  });

  it('is idle before anything was asked', () => {
    expect(make().status('shop.test')).toEqual({
      state: 'idle',
      step: null,
      phpVersion: '8.4',
      error: null,
    });
  });
});

describe('repair', () => {
  it("restarts only the Site's PHP version and reports healthy", async () => {
    const r = make();
    expect(await r.repair('old.test')).toEqual({
      state: 'healthy',
      step: null,
      phpVersion: '8.2',
      error: null,
    });
    expect(restarts).toEqual(['8.2']);
  });

  it('reports the step while the restart runs', async () => {
    gates.hold = true;
    const r = make();
    const done = r.repair('shop.test');
    expect(r.status('shop.test')).toEqual({
      state: 'repairing',
      step: 'restart-php',
      phpVersion: '8.4',
      error: null,
    });
    gates['8.4']();
    await done;
    expect(r.status('shop.test').state).toBe('healthy');
  });

  it('runs a Site with no recorded version on the active one', async () => {
    await make().repair('legacy.test');
    expect(restarts).toEqual(['8.3']);
  });

  it("fails with the restart's error text", async () => {
    failing['8.4'] = 'php@8.4 exited repeatedly. Log tail: bad ini';
    const st = await make().repair('shop.test');
    expect(st).toMatchObject({ state: 'failed', error: failing['8.4'] });
  });

  it('fails (not stuck repairing) when the restart throws straight away', async () => {
    const r = make({
      restartFpm: () => {
        throw new Error('PHP 8.4 is not installed');
      },
    });
    expect(await r.repair('shop.test')).toMatchObject({ state: 'failed' });
    expect(r.status('shop.test')).toMatchObject({
      state: 'failed',
      error: 'PHP 8.4 is not installed',
    });
  });

  it('fails when PHP restarted but its socket still refuses connections', async () => {
    accepting['8.4'] = false;
    const st = await make().repair('shop.test');
    expect(st.state).toBe('failed');
    expect(st.error).toMatch(/PHP 8\.4/);
  });
});

describe('concurrent repairs', () => {
  it('join the repair already running for the same version', async () => {
    gates.hold = true;
    const r = make();
    const first = r.repair('shop.test');
    const second = r.repair('blog.test'); // same version, other Site
    const third = r.repair('shop.test'); // same Site again
    expect(restarts).toEqual(['8.4']);
    expect(r.status('blog.test').state).toBe('repairing');
    gates['8.4']();
    const results = await Promise.all([first, second, third]);
    expect(results.map((s) => s.state)).toEqual(['healthy', 'healthy', 'healthy']);
    expect(restarts).toEqual(['8.4']);
  });

  it("don't hold up a different version", async () => {
    gates.hold = true;
    const r = make();
    const a = r.repair('shop.test');
    const c = r.repair('old.test');
    expect(restarts).toEqual(['8.4', '8.2']);
    gates['8.4']();
    gates['8.2']();
    await Promise.all([a, c]);
  });
});

describe('per-Site limit', () => {
  it('stops after three repairs a minute and reports limited', async () => {
    const r = make();
    for (let i = 0; i < 3; i++) {
      expect((await r.repair('shop.test')).state).toBe('healthy');
      clock += 1000;
    }
    const st = await r.repair('shop.test');
    expect(st.state).toBe('limited');
    expect(st.error).toBeTruthy();
    expect(r.status('shop.test').state).toBe('limited');
    expect(restarts).toEqual(['8.4', '8.4', '8.4']);
  });

  it("is per Site: one Site's limit doesn't block another", async () => {
    const r = make();
    for (let i = 0; i < 4; i++) await r.repair('shop.test');
    expect((await r.repair('blog.test')).state).toBe('healthy');
  });

  it('allows repair again once the window has passed', async () => {
    const r = make();
    for (let i = 0; i < 4; i++) await r.repair('shop.test');
    clock += 60_000;
    expect((await r.repair('shop.test')).state).toBe('healthy');
  });

  it("doesn't count a request that only joined a running repair", async () => {
    gates.hold = true;
    const r = make();
    const runs = [r.repair('shop.test'), r.repair('shop.test'), r.repair('shop.test')];
    runs.push(r.repair('shop.test'));
    gates['8.4']();
    await Promise.all(runs);
    gates.hold = false;
    expect((await r.repair('shop.test')).state).toBe('healthy');
    expect(restarts).toEqual(['8.4', '8.4']);
  });
});
