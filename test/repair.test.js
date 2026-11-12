import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import repair from '../electron/services/repair.cjs';

// The repair the 502 page asks for: restart the PHP-FPM version of the Site
// the request's host names — that version only — with joined concurrent
// repairs and the app's own per-Site limit.

let restarts; // versions restarted, in order
let accepting; // version -> socket accepts after restart
let failing; // version -> error thrown by its restart
let gates; // version -> resolve() to let its restart finish
let clock;
let steps; // every step taken, in order: 'php 8.4', 'reload-nginx', 'restart-nginx'
let nginxFixes; // the nginx step after which the socket accepts again
let logs; // version -> PHP-FPM process log text

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
        steps.push(`php ${v}`);
        const finish = () => (failing[v] ? reject(new Error(failing[v])) : resolve());
        if (gates.hold) gates[v] = finish;
        else finish();
      }),
    fpmAccepts: async (v) => accepting[v] !== false,
    fpmLogMark: (v) => (logs[v] || '').length,
    fpmLogSince: (v, mark) => (logs[v] || '').slice(mark),
    reloadNginx: async () => nginxStep('reload-nginx'),
    restartNginx: async () => nginxStep('restart-nginx'),
    now: () => clock,
    ...over,
  });

// An nginx step: logged, and when it's the fixing one the socket accepts
// from then on.
function nginxStep(step) {
  steps.push(step);
  if (nginxFixes === step) for (const v of Object.keys(accepting)) accepting[v] = true;
}

beforeEach(() => {
  steps = [];
  nginxFixes = null;
  logs = {};
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

describe('escalation', () => {
  it('stops at the PHP restart when that brings the socket back', async () => {
    expect((await make().repair('shop.test')).state).toBe('healthy');
    expect(steps).toEqual(['php 8.4']);
  });

  it('reloads nginx when PHP restarted but stays unreachable, and stops there if that works', async () => {
    accepting['8.4'] = false;
    nginxFixes = 'reload-nginx';
    expect((await make().repair('shop.test')).state).toBe('healthy');
    expect(steps).toEqual(['php 8.4', 'reload-nginx']);
  });

  it('restarts nginx when the reload did not help', async () => {
    accepting['8.4'] = false;
    nginxFixes = 'restart-nginx';
    expect((await make().repair('shop.test')).state).toBe('healthy');
    expect(steps).toEqual(['php 8.4', 'reload-nginx', 'restart-nginx']);
  });

  it('goes on to the restart when the reload itself fails', async () => {
    accepting['8.4'] = false;
    nginxFixes = 'restart-nginx';
    const r = make({
      reloadNginx: async () => {
        steps.push('reload-nginx');
        throw new Error('nginx config test failed');
      },
    });
    expect((await r.repair('shop.test')).state).toBe('healthy');
    expect(steps).toEqual(['php 8.4', 'reload-nginx', 'restart-nginx']);
  });

  it('fails after every step when the socket never comes back', async () => {
    accepting['8.4'] = false;
    const st = await make().repair('shop.test');
    expect(st).toMatchObject({ state: 'failed', step: null });
    expect(steps).toEqual(['php 8.4', 'reload-nginx', 'restart-nginx']);
  });

  it("doesn't touch nginx when PHP itself couldn't start — nginx can't fix that", async () => {
    failing['8.4'] = 'php@8.4 exited during startup';
    expect((await make().repair('shop.test')).state).toBe('failed');
    expect(steps).toEqual(['php 8.4']);
  });

  it('never restarts another PHP version at any step', async () => {
    accepting['8.4'] = false;
    await make().repair('shop.test');
    expect(restarts).toEqual(['8.4']);
  });

  it('reports each step while it runs', async () => {
    accepting['8.4'] = false;
    const seen = [];
    let r;
    const hold = (step) => async () => {
      steps.push(step);
      seen.push(r.status('shop.test'));
    };
    r = make({ reloadNginx: hold('reload-nginx'), restartNginx: hold('restart-nginx') });
    await r.repair('shop.test');
    expect(seen.map((s) => [s.state, s.step])).toEqual([
      ['repairing', 'reload-nginx'],
      ['repairing', 'restart-nginx'],
    ]);
  });

  it('shares one nginx step between versions repairing at the same time', async () => {
    accepting['8.4'] = false;
    accepting['8.2'] = false;
    let release;
    const r = make({
      reloadNginx: () => {
        steps.push('reload-nginx');
        return new Promise((resolve) => (release = resolve));
      },
    });
    const a = r.repair('shop.test');
    const c = r.repair('old.test');
    await new Promise((x) => setTimeout(x, 0));
    accepting['8.4'] = true;
    accepting['8.2'] = true;
    release();
    await Promise.all([a, c]);
    expect(steps.filter((s) => s === 'reload-nginx')).toEqual(['reload-nginx']);
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

// Shaped like php-fpm's stderr when it can't load its config.
const BROKEN_CONFIG = [
  "[12-Nov-2026 10:00:01] ERROR: [/opt/homebrew/etc/php/8.4/php-fpm.d/www.conf:23] unknown entry 'pm.max_kids'",
  "[12-Nov-2026 10:00:01] ERROR: failed to load configuration file '/opt/homebrew/etc/php/8.4/wpxen-fpm.conf'",
  '[12-Nov-2026 10:00:01] ERROR: FPM initialization failed',
].join('\n');

describe('error text from the PHP-FPM process log', () => {
  it("fails with PHP-FPM's own error text, not the supervisor's summary", async () => {
    logs['8.4'] = '[12-Nov-2026 09:00:00] NOTICE: fpm is running, pid 10\n';
    const r = make({
      restartFpm: async (v) => {
        logs[v] += BROKEN_CONFIG + '\n';
        throw new Error('php@8.4 exited during startup (last code 78).');
      },
    });
    expect(await r.repair('shop.test')).toEqual({
      state: 'failed',
      step: null,
      phpVersion: '8.4',
      error: BROKEN_CONFIG,
    });
  });

  it('shows the error text while the repair is still running', async () => {
    let finish;
    const r = make({
      restartFpm: (v) =>
        new Promise((_, reject) => {
          logs[v] = (logs[v] || '') + BROKEN_CONFIG + '\n';
          finish = () => reject(new Error('php@8.4 exited during startup'));
        }),
    });
    const done = r.repair('shop.test');
    expect(r.status('shop.test')).toMatchObject({
      state: 'repairing',
      step: 'restart-php',
      error: BROKEN_CONFIG,
    });
    finish();
    await done;
  });

  it('ignores what the log held before this repair began', async () => {
    logs['8.4'] = BROKEN_CONFIG + '\n';
    accepting['8.4'] = false;
    const st = await make().repair('shop.test');
    expect(st.state).toBe('failed');
    expect(st.error).not.toContain('unknown entry');
  });

  it("falls back to the step's own error when the log says nothing new", async () => {
    failing['8.4'] = 'PHP 8.4 is not installed';
    expect((await make().repair('shop.test')).error).toBe('PHP 8.4 is not installed');
  });
});

describe('fpmErrorText', () => {
  it('keeps error lines and drops routine notices', () => {
    const text = [
      '[12-Nov-2026 10:00:00] NOTICE: fpm is running, pid 10',
      BROKEN_CONFIG,
      '[12-Nov-2026 10:00:02] NOTICE: exiting, bye-bye!',
    ].join('\n');
    expect(repair.fpmErrorText(text)).toBe(BROKEN_CONFIG);
  });

  it('keeps lines php-fpm writes without a level, such as a loader error', () => {
    const text =
      'dyld[123]: Library not loaded: /opt/homebrew/opt/icu4c/lib/libicuio.74.dylib\n';
    expect(repair.fpmErrorText(text)).toBe(
      'dyld[123]: Library not loaded: /opt/homebrew/opt/icu4c/lib/libicuio.74.dylib'
    );
  });

  it('is null for nothing, or nothing but notices', () => {
    expect(repair.fpmErrorText('')).toBeNull();
    expect(repair.fpmErrorText(null)).toBeNull();
    expect(repair.fpmErrorText('[x] NOTICE: ready to handle connections\n\n')).toBeNull();
  });

  it('keeps only the last few lines', () => {
    const many = Array.from({ length: 40 }, (_, i) => `[t] ERROR: line ${i}`).join('\n');
    const out = repair.fpmErrorText(many).split('\n');
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.at(-1)).toBe('[t] ERROR: line 39');
  });
});

describe('reading the log since a mark', () => {
  let dir;
  let file;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-fpmlog-'));
    file = path.join(dir, 'php@8.4.log');
    return () => fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads only what was written after the mark', () => {
    fs.writeFileSync(file, 'old line\n');
    const mark = repair.logMark(file);
    fs.appendFileSync(file, 'new line\n');
    expect(repair.readLogSince(file, mark)).toBe('new line\n');
  });

  it('reads from the start of a log rotated since the mark', () => {
    fs.writeFileSync(file, 'x'.repeat(100));
    const mark = repair.logMark(file);
    fs.writeFileSync(file, 'fresh\n'); // procman renamed the old one aside
    expect(repair.readLogSince(file, mark)).toBe('fresh\n');
  });

  it('is empty for a log that does not exist', () => {
    expect(repair.logMark(path.join(dir, 'missing.log'))).toBe(0);
    expect(repair.readLogSince(path.join(dir, 'missing.log'), 0)).toBe('');
  });

  it('reads at most the tail, starting on a whole line', () => {
    fs.writeFileSync(file, '');
    const mark = repair.logMark(file);
    fs.appendFileSync(file, 'a'.repeat(50) + '\n' + 'last\n');
    expect(repair.readLogSince(file, mark, 20)).toBe('last\n');
  });
});
