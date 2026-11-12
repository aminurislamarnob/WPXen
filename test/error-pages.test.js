import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';

// The 502 error page: the line every vhost gains, the shared snippet it
// includes, the static page, and the page's attempt limiter.
//
// Loaded through Node's require so the brew stub reaches the copy nginx.cjs
// requires internally (see per-site-php.test.js).
const require = createRequire(import.meta.url);
const brew = require('../electron/services/brew.cjs');
const nginx = require('../electron/services/nginx.cjs');
const errorPages = require('../electron/services/errorPages.cjs');

const PREFIX = '/opt/homebrew';
const SNIPPET = `${PREFIX}/etc/nginx/wpxen/wpxen-errors.conf`;
const SOCKET = `${PREFIX}/var/run/wpxen/wpxen-repair.sock`;
const saved = {};

beforeAll(() => {
  saved.getBrewPrefix = brew.getBrewPrefix;
  saved.getActivePhpVersion = brew.getActivePhpVersion;
  brew.getBrewPrefix = () => PREFIX;
  brew.getActivePhpVersion = () => '8.4';
});

afterAll(() => Object.assign(brew, saved));

const site = (over = {}) => ({
  name: 'Shop',
  domain: 'shop.test',
  path: '/Users/me/Sites/shop',
  phpVersion: '8.4',
  ...over,
});

const count = (text, needle) => text.split(needle).length - 1;

describe('vhost', () => {
  it('includes the shared WPXen snippet with one line', () => {
    const conf = nginx.generateSiteConfig(site());
    expect(count(conf, `include ${SNIPPET};`)).toBe(1);
  });

  it('includes it in the TLS server, not the port-80 redirect', () => {
    const conf = nginx.generateSiteConfig(
      site({ https: true, certPath: '/c/shop.pem', keyPath: '/c/shop-key.pem' })
    );
    expect(count(conf, `include ${SNIPPET};`)).toBe(1);
    const [redirect, tls] = conf.split('listen 443 ssl;');
    expect(redirect).not.toContain('include ');
    expect(tls).toContain(`include ${SNIPPET};`);
  });
});

describe('snippet', () => {
  const snippet = errorPages.buildErrorSnippet({
    socketPath: SOCKET,
    pagesDir: `${PREFIX}/etc/nginx/wpxen`,
  });

  it('serves the WPXen 504 page for a timeout, internally only', () => {
    expect(snippet).toContain('error_page 504 /__wpxen/504.html;');
    expect(snippet).toMatch(
      /location = \/__wpxen\/504\.html \{[^}]*internal;[^}]*alias \/opt\/homebrew\/etc\/nginx\/wpxen\/504\.html;/
    );
  });

  it('serves the WPXen page for a 502, internally only', () => {
    expect(snippet).toContain('error_page 502 /__wpxen/502.html;');
    expect(snippet).toMatch(
      /location = \/__wpxen\/502\.html \{[^}]*internal;[^}]*alias \/opt\/homebrew\/etc\/nginx\/wpxen\/502\.html;/
    );
  });

  it('proxies exactly the repair and status routes to the socket, passing the host', () => {
    for (const route of ['repair', 'status']) {
      const block = snippet.match(new RegExp(`location = /__wpxen/${route} \\{[^}]*\\}`));
      expect(block, route).not.toBeNull();
      expect(block[0]).toContain(`proxy_pass http://unix:${SOCKET}:;`);
      expect(block[0]).toContain('proxy_set_header Host $host;');
    }
    expect(count(snippet, 'proxy_pass ')).toBe(2);
  });

  it('answers the repair and status routes only to this machine, never the LAN', () => {
    for (const route of ['repair', 'status']) {
      const block = snippet.match(new RegExp(`location = /__wpxen/${route} \\{[^}]*\\}`))[0];
      expect(block).toMatch(/allow 127\.0\.0\.1;\s*allow ::1;\s*deny all;/);
      // The access check comes before the proxy, so a denied request never reaches the app.
      expect(block.indexOf('deny all;')).toBeLessThan(block.indexOf('proxy_pass'));
    }
  });

  it('reserves the rest of /__wpxen/ so it never reaches WordPress', () => {
    expect(snippet).toMatch(/location \^~ \/__wpxen\/ \{\s*return 404;\s*\}/);
  });

  it('holds only server-level directives (no http/server blocks)', () => {
    expect(snippet).not.toMatch(/^\s*(http|server)\s*\{/m);
  });

  it('refuses paths nginx would misparse', () => {
    expect(() =>
      errorPages.buildErrorSnippet({
        socketPath: '/Users/me/Library/Application Support/WPXen/r.sock',
        pagesDir: '/x',
      })
    ).toThrow();
    expect(() =>
      errorPages.buildErrorSnippet({ socketPath: SOCKET, pagesDir: '/x;}' })
    ).toThrow();
  });
});

describe('the files on disk', () => {
  it('writes the snippet and the page into the WPXen folder, outside servers/', () => {
    const confDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-nginx-'));
    try {
      const out = errorPages.ensureErrorPages({ confDir, prefix: PREFIX });
      expect(out.snippetPath).toBe(path.join(confDir, 'wpxen', 'wpxen-errors.conf'));
      expect(fs.readFileSync(out.snippetPath, 'utf8')).toContain(SOCKET);
      const page = fs.readFileSync(path.join(confDir, 'wpxen', '502.html'), 'utf8');
      expect(page).toContain('<!doctype html>');
      expect(page).toContain(`${PREFIX}/var/log/php-fpm.log`);
      const page504 = fs.readFileSync(path.join(confDir, 'wpxen', '504.html'), 'utf8');
      expect(page504).toContain('Restart PHP');
      expect(fs.existsSync(path.join(confDir, 'servers'))).toBe(false);
    } finally {
      fs.rmSync(confDir, { recursive: true, force: true });
    }
  });
});

describe('writing a vhost', () => {
  it('puts the snippet it includes on disk first', () => {
    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-prefix-'));
    const real = brew.getBrewPrefix;
    brew.getBrewPrefix = () => prefix;
    try {
      const confPath = nginx.createSiteConfig(site());
      const included = fs.readFileSync(confPath, 'utf8').match(/include (\S+);/)[1];
      expect(included).toBe(`${prefix}/etc/nginx/wpxen/wpxen-errors.conf`);
      expect(fs.readFileSync(included, 'utf8')).toContain(
        `proxy_pass http://unix:${prefix}/var/run/wpxen/wpxen-repair.sock:;`
      );
      expect(fs.existsSync(`${prefix}/etc/nginx/wpxen/502.html`)).toBe(true);
    } finally {
      brew.getBrewPrefix = real;
      fs.rmSync(prefix, { recursive: true, force: true });
    }
  });
});

describe('502 page', () => {
  const page = errorPages.build502Page({ logPath: `${PREFIX}/var/log/php-fpm.log` });

  it('asks for a repair, polls status, and checks the original URL with HEAD', () => {
    expect(page).toContain("'/__wpxen/repair'");
    expect(page).toContain("'/__wpxen/status'");
    expect(page).toContain("method: 'HEAD'");
    expect(page).toContain('Try again');
  });

  it('embeds the same limiter the tests exercise', () => {
    expect(page).toContain(errorPages.nextAttempt.toString());
  });

  it('escapes the log path into the markup', () => {
    const odd = errorPages.build502Page({ logPath: '/a/<b>&"c' });
    expect(odd).toContain('/a/&lt;b&gt;&amp;&quot;c');
    expect(odd).not.toContain('<b>');
  });
});

describe('nextAttempt (the page limiter)', () => {
  const { nextAttempt } = errorPages;
  const MIN = 60_000;

  it('allows the first two attempts in a minute and records them', () => {
    const a = nextAttempt([], 1000);
    expect(a).toEqual({ allowed: true, history: [1000] });
    const b = nextAttempt(a.history, 5000);
    expect(b).toEqual({ allowed: true, history: [1000, 5000] });
  });

  it('refuses a third within the minute', () => {
    expect(nextAttempt([1000, 5000], 30_000)).toEqual({
      allowed: false,
      history: [1000, 5000],
    });
  });

  it('allows again once the oldest attempt is a minute old', () => {
    expect(nextAttempt([1000, 5000], 1000 + MIN)).toEqual({
      allowed: true,
      history: [5000, 1000 + MIN],
    });
  });

  it('treats garbage from storage as no history', () => {
    expect(nextAttempt(null, 10).allowed).toBe(true);
    expect(nextAttempt(['x', {}], 10)).toEqual({ allowed: true, history: [10] });
    // A timestamp from the future (clock moved back) doesn't block forever.
    expect(nextAttempt([10 * MIN, 10 * MIN], 0).allowed).toBe(true);
  });
});

describe('stepMessage (what the page says is running)', () => {
  const { stepMessage } = errorPages;

  it('names the PHP version while PHP restarts', () => {
    expect(stepMessage({ step: 'restart-php', phpVersion: '8.4' })).toBe(
      'Restarting PHP 8.4…'
    );
  });

  it('says when the repair moved on to nginx', () => {
    expect(stepMessage({ step: 'reload-nginx', phpVersion: '8.4' })).toMatch(
      /Reloading nginx/
    );
    expect(stepMessage({ step: 'restart-nginx', phpVersion: '8.4' })).toMatch(
      /Restarting nginx/
    );
  });

  it('copes with a status that carries no version or step', () => {
    expect(stepMessage({})).toBe('Restarting PHP…');
    expect(stepMessage(null)).toBe('Restarting PHP…');
  });

  it('is embedded in both pages', () => {
    const logPath = `${PREFIX}/var/log/php-fpm.log`;
    expect(errorPages.build502Page({ logPath })).toContain(stepMessage.toString());
    expect(errorPages.build504Page({ logPath })).toContain(stepMessage.toString());
  });
});

// Runs a page's script against a stub document — just the ids it touches —
// with fetch answered by `respond(method, url)`. No DOM library needed.
function runPage(html, respond) {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const els = {};
  const el = (id) =>
    (els[id] ||= {
      id,
      textContent: '',
      hidden: new RegExp(`id="${id}"[^>]*\\shidden`).test(html),
      disabled: false,
      listeners: {},
      addEventListener(type, fn) {
        this.listeners[type] = fn;
      },
      click() {
        return this.listeners.click && this.listeners.click();
      },
    });
  const fetches = [];
  const store = new Map();
  const reloads = [];
  const context = {
    document: { getElementById: el },
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    location: { href: 'http://shop.test/cart', reload: () => reloads.push(1) },
    setTimeout: (fn) => setImmediate(fn), // polls run without waiting
    fetch: async (url, opts = {}) => {
      const method = opts.method || 'GET';
      fetches.push(`${method} ${url}`);
      const { status = 200, body = null } = await respond(method, url);
      return { ok: status < 400, status, json: async () => body };
    },
  };
  vm.runInNewContext(script, context);
  return { el, fetches, reloads };
}

const settle = async (check) => {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('page never settled');
    await new Promise((r) => setImmediate(r));
  }
};

const st = (state, extra = {}) => ({
  state,
  step: null,
  phpVersion: '8.4',
  error: null,
  ...extra,
});

describe('502 page behaviour', () => {
  const page = errorPages.build502Page({ logPath: `${PREFIX}/var/log/php-fpm.log` });

  it('shows which step is running, and the error text so far', async () => {
    const statuses = [
      st('repairing', {
        step: 'reload-nginx',
        error: '[t] ERROR: FPM initialization failed',
      }),
      st('repairing', { step: 'restart-nginx' }),
    ];
    let release;
    const gate = new Promise((r) => (release = r));
    const { el } = runPage(page, async (method) => {
      if (method === 'POST') return { body: st('repairing', { step: 'restart-php' }) };
      if (method === 'HEAD') return { status: 200 };
      if (statuses.length) return { body: statuses.shift() };
      await gate;
      return { body: st('healthy') };
    });
    await settle(() => el('message').textContent.includes('Reloading nginx'));
    expect(el('message').textContent).toMatch(/PHP 8\.4 still isn't answering/);
    expect(el('error').textContent).toBe('[t] ERROR: FPM initialization failed');
    expect(el('error').hidden).toBe(false);
    await settle(() => el('message').textContent.includes('Restarting nginx'));
    release();
  });

  it('keeps polling through a dropped connection while nginx restarts', async () => {
    let polls = 0;
    const { reloads } = runPage(page, async (method) => {
      if (method === 'POST') return { body: st('repairing', { step: 'restart-nginx' }) };
      if (method === 'HEAD') return { status: 200 };
      polls += 1;
      if (polls < 3) throw new TypeError('Failed to fetch');
      return { body: st('healthy') };
    });
    await settle(() => reloads.length === 1);
    expect(polls).toBe(3);
  });

  it("shows PHP-FPM's error text once the repair fails for good", async () => {
    const error = "[t] ERROR: failed to load configuration file '/x/wpxen-fpm.conf'";
    const { el, fetches } = runPage(page, async () => ({
      body: st('failed', { error }),
    }));
    await settle(() => !el('stopped').hidden);
    expect(el('error').textContent).toBe(error);
    expect(fetches.filter((f) => f.startsWith('POST'))).toHaveLength(2); // the page's budget
  });
});

describe('504 page', () => {
  const page = errorPages.build504Page({ logPath: `${PREFIX}/var/log/php-fpm.log` });

  it('explains the timeout and offers Restart PHP', () => {
    expect(page).toContain('<!doctype html>');
    expect(page).toMatch(/took too long/);
    expect(page).toContain('Restart PHP');
    expect(page).toContain(`${PREFIX}/var/log/php-fpm.log`);
  });

  it('never asks for a repair on its own', async () => {
    const { fetches } = runPage(page, async () => ({ body: st('healthy') }));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetches).toEqual([]);
  });

  it('restarts PHP through the repair route when Restart PHP is clicked', async () => {
    const { el, fetches, reloads } = runPage(page, async (method) =>
      method === 'POST'
        ? { body: st('repairing', { step: 'restart-php' }) }
        : { body: st('healthy') }
    );
    el('restart').click();
    await settle(() => !el('reload').hidden);
    expect(fetches).toEqual(['POST /__wpxen/repair', 'GET /__wpxen/status']);
    expect(el('message').textContent).toMatch(/PHP 8\.4 restarted/);
    // The slow request isn't re-run behind the user's back.
    expect(reloads).toEqual([]);
  });

  it('shows the error text when the restart fails', async () => {
    const error = '[t] ERROR: FPM initialization failed';
    const { el } = runPage(page, async () => ({ body: st('failed', { error }) }));
    el('restart').click();
    await settle(() => el('error').textContent === error);
    expect(el('error').hidden).toBe(false);
  });
});
