import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import wordpress from '../electron/services/wordpress.cjs';

describe('sanitizeDomain', () => {
  it('lowercases and strips shell metacharacters', () => {
    expect(wordpress.sanitizeDomain('Foo`Bar!.test')).toBe('foo-bar-test');
  });

  it('collapses and trims separators', () => {
    expect(wordpress.sanitizeDomain('  My  Site  ')).toBe('my-site');
  });
});

describe('sanitizeDbName', () => {
  it('replaces unsafe characters with underscores', () => {
    expect(wordpress.sanitizeDbName('a-b;c')).toBe('a_b_c');
  });

  it('produces a valid MySQL identifier', () => {
    expect(wordpress.sanitizeDbName('My Blog!')).toMatch(/^[a-z0-9_]+$/);
  });
});

describe('generateId', () => {
  it('produces unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => wordpress.generateId()));
    expect(ids.size).toBe(1000);
  });
});

describe('selectExistingPlugins', () => {
  const present = new Set([
    'woocommerce/woocommerce.php',
    'akismet/akismet.php',
    'hello.php',
  ]);
  const exists = (p) => present.has(p);

  it('keeps only plugins whose file exists', () => {
    const input = ['woocommerce/woocommerce.php', 'missing/missing.php', 'hello.php'];
    expect(wordpress.selectExistingPlugins(input, exists)).toEqual([
      'woocommerce/woocommerce.php',
      'hello.php',
    ]);
  });

  it('de-duplicates and ignores non-string entries', () => {
    const input = ['hello.php', 'hello.php', null, 42, ''];
    expect(wordpress.selectExistingPlugins(input, exists)).toEqual(['hello.php']);
  });

  it('returns [] for non-array input', () => {
    expect(wordpress.selectExistingPlugins(undefined, exists)).toEqual([]);
    expect(wordpress.selectExistingPlugins(null, exists)).toEqual([]);
  });
});

// The must-use plugin that points WordPress's HTTP API at WPXen's trust
// bundle. WordPress ignores PHP's openssl.cafile / curl.cainfo (Requests passes
// its own bundled CA file), so without it wp_remote_get to another local HTTPS
// Site — and Site Health's loopback check — fail verification.
describe('local-trust must-use plugin', () => {
  const BUNDLE = '/opt/homebrew/etc/wpxen/ca-bundle.pem';
  const text = wordpress.buildLocalTrustMuPlugin(BUNDLE);

  it('swaps the bundle in through http_request_args', () => {
    expect(text).toMatch(/^<\?php/);
    expect(text).toContain("add_filter('http_request_args'");
    expect(text).toContain("$args['sslcertificates']");
    expect(text).toContain(`'${BUNDLE}'`);
  });

  it("leaves WordPress's default alone when the bundle is missing", () => {
    expect(text).toContain('is_readable(');
  });

  it("only replaces WordPress's own default, not a bundle a plugin chose", () => {
    expect(text).toContain("ABSPATH . WPINC . '/certificates/ca-bundle.crt'");
  });

  it('never disables verification', () => {
    expect(text).not.toMatch(/sslverify/);
  });

  it('escapes the path for a PHP single-quoted string', () => {
    const odd = wordpress.buildLocalTrustMuPlugin("/a b/it's\\here.pem");
    expect(odd).toContain("'/a b/it\\'s\\\\here.pem'");
  });

  describe('on disk', () => {
    let site;
    beforeEach(() => {
      site = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-site-'));
      fs.mkdirSync(path.join(site, 'wp-content'));
    });
    afterEach(() => fs.rmSync(site, { recursive: true, force: true }));
    const mu = (name) => path.join(site, 'wp-content', 'mu-plugins', name);

    it('writes wpxen-local-trust.php, once', () => {
      expect(wordpress.ensureLocalTrustMuPlugin(site, BUNDLE)).toBe(true);
      expect(fs.readFileSync(mu('wpxen-local-trust.php'), 'utf8')).toBe(text);
      expect(wordpress.ensureLocalTrustMuPlugin(site, BUNDLE)).toBe(false);
    });

    it('deletes copies left under the pre-rename names', () => {
      fs.mkdirSync(path.join(site, 'wp-content', 'mu-plugins'));
      fs.writeFileSync(mu('wpherd-local-trust.php'), '<?php');
      fs.writeFileSync(mu('wpdevpilot-local-trust.php'), '<?php');
      wordpress.ensureLocalTrustMuPlugin(site, BUNDLE);
      expect(fs.existsSync(mu('wpherd-local-trust.php'))).toBe(false);
      expect(fs.existsSync(mu('wpdevpilot-local-trust.php'))).toBe(false);
    });

    it('skips a folder that is not a WordPress install', () => {
      fs.rmSync(path.join(site, 'wp-content'), { recursive: true });
      expect(wordpress.ensureLocalTrustMuPlugin(site, BUNDLE)).toBe(false);
    });

    // Two mu-plugins declaring the same PHP function fatal the Site.
    it('declares no function another WPXen mu-plugin declares', () => {
      wordpress.ensureTunnelMuPlugin(site);
      wordpress.ensureMagicLoginMuPlugin(site, { userId: 1, secret: 'a'.repeat(32) });
      const names = (src) => [...src.matchAll(/function\s+(\w+)\s*\(/g)].map((m) => m[1]);
      const others = new Set([
        ...names(fs.readFileSync(mu('wpxen-tunnel.php'), 'utf8')),
        ...names(fs.readFileSync(mu('wpxen-magic-login.php'), 'utf8')),
      ]);
      const ours = names(text);
      expect(ours.length).toBeGreaterThan(0);
      expect(ours.filter((n) => others.has(n))).toEqual([]);
    });
  });
});
