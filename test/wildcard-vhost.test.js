import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

// Every Site's vhost answers to its wildcard too, so `sub.shop.test` reaches
// the Site its certificate (mkcert.certArgs) already covers. nginx prefers an
// exact name over a wildcard, so a separate Site at `blog.shop.test` keeps
// its own vhost.
//
// Loaded through Node's require so the stubs below reach the copies nginx.cjs
// requires internally (see per-site-php.test.js).
const require = createRequire(import.meta.url);
const brew = require('../electron/services/brew.cjs');
const nginx = require('../electron/services/nginx.cjs');

const PREFIX = '/opt/homebrew';
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

const serverNames = (conf) =>
  [...conf.matchAll(/server_name ([^;]+);/g)].map((m) => m[1]);

const httpsSite = site({
  https: true,
  certPath: `${PREFIX}/etc/nginx/certs/shop.test.pem`,
  keyPath: `${PREFIX}/etc/nginx/certs/shop.test-key.pem`,
});

describe('vhost server names', () => {
  it('answers to the domain and its wildcard over http', () => {
    expect(serverNames(nginx.generateSiteConfig(site()))).toEqual([
      'shop.test *.shop.test',
    ]);
  });

  it('answers to both on the https server and its http redirect', () => {
    const conf = nginx.generateSiteConfig(httpsSite);
    expect(serverNames(conf)).toEqual(['shop.test *.shop.test', 'shop.test *.shop.test']);
    // The redirect keeps the subdomain the request came in on.
    expect(conf).toContain('return 301 https://$host$request_uri;');
  });

  it('keeps a transient share-host alias, and gives it no wildcard', () => {
    const conf = nginx.generateSiteConfig({
      ...httpsSite,
      aliases: ['random-words-1234.trycloudflare.com'],
    });
    expect(serverNames(conf)).toEqual([
      'shop.test *.shop.test random-words-1234.trycloudflare.com',
      'shop.test *.shop.test random-words-1234.trycloudflare.com',
    ]);
    expect(conf).not.toContain('*.random-words-1234.trycloudflare.com');
  });
});
