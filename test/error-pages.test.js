import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

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
