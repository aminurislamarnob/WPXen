import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const brew = require('../electron/services/brew.cjs');
const php = require('../electron/services/php.cjs');
const procman = require('../electron/services/procman.cjs');

// zz-wpxen.ini carries the two certificate directives that point PHP's
// openssl and curl at WPXen's trust bundle. The file used to be written only
// when a PHP setting changed, so the directives need a write path of their own
// that keeps whatever settings (and legacy-file values) are already there.

let tmp;
let versions;
let saved;
const iniPath = (v, name = 'zz-wpxen.ini') =>
  path.join(tmp, 'etc/php', v, 'conf.d', name);
const bundlePath = () => path.join(tmp, 'etc/wpxen/ca-bundle.pem');
const writeBundle = () => {
  fs.mkdirSync(path.dirname(bundlePath()), { recursive: true });
  fs.writeFileSync(
    bundlePath(),
    '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n'
  );
};
const write = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-ini-'));
  saved = brew.getBrewPrefix;
  brew.getBrewPrefix = () => tmp;
  versions = ['8.3', '8.4'];
  php.__setDeps({
    installedVersions: () => versions,
    procman: { status: () => ({ state: 'stopped' }), isSupervised: () => false },
  });
});

afterEach(() => {
  brew.getBrewPrefix = saved;
  php.__setDeps({ installedVersions: () => brew.getInstalledPhpVersions(), procman });
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('buildManagedIni', () => {
  it('points openssl and curl at the bundle, quoted', () => {
    const text = php.buildManagedIni(
      {},
      { caBundle: '/Users/me/A Folder/ca-bundle.pem' }
    );
    expect(text).toContain('openssl.cafile = "/Users/me/A Folder/ca-bundle.pem"');
    expect(text).toContain('curl.cainfo = "/Users/me/A Folder/ca-bundle.pem"');
  });

  it('omits both directives when there is no bundle', () => {
    const text = php.buildManagedIni({ memory_limit: 256 });
    expect(text).not.toContain('openssl.cafile');
    expect(text).not.toContain('curl.cainfo');
    expect(text).toContain('memory_limit = 256M');
  });

  it('never turns verification off', () => {
    const text = php.buildManagedIni({}, { caBundle: '/x/ca-bundle.pem' });
    expect(text).not.toMatch(/verify_peer|CURLOPT_SSL_VERIFY|sslverify/i);
  });
});

describe('syncManagedIniAllVersions', () => {
  it('writes the directives for every installed version', () => {
    writeBundle();
    php.syncManagedIniAllVersions();
    for (const v of versions) {
      const text = fs.readFileSync(iniPath(v), 'utf8');
      expect(text).toContain(`openssl.cafile = "${bundlePath()}"`);
      expect(text).toContain(`curl.cainfo = "${bundlePath()}"`);
    }
  });

  it("doesn't impose default settings on a version nobody customised", () => {
    writeBundle();
    php.syncManagedIniAllVersions();
    const text = fs.readFileSync(iniPath('8.3'), 'utf8');
    expect(text).not.toContain('memory_limit');
    expect(text).not.toContain('upload_max_filesize');
  });

  it('keeps settings the user already customised', () => {
    write(
      iniPath('8.4'),
      '; Managed by WPXen — edit these from the app.\n\n; wpxen:memory_limit=1024\nmemory_limit = 1024M\n'
    );
    writeBundle();
    php.syncManagedIniAllVersions();
    const text = fs.readFileSync(iniPath('8.4'), 'utf8');
    expect(text).toContain('; wpxen:memory_limit=1024');
    expect(text).toContain('memory_limit = 1024M');
    expect(text).toContain('openssl.cafile');
  });

  it('carries a legacy file’s values over and deletes it', () => {
    write(
      iniPath('8.3', 'zz-wpherd.ini'),
      '; wpherd:max_execution_time=300\nmax_execution_time = 300\n'
    );
    writeBundle();
    php.syncManagedIniAllVersions();
    expect(fs.existsSync(iniPath('8.3', 'zz-wpherd.ini'))).toBe(false);
    const text = fs.readFileSync(iniPath('8.3'), 'utf8');
    expect(text).toContain('max_execution_time = 300');
    expect(text).toContain('curl.cainfo');
  });

  it('reaches a version installed later', () => {
    writeBundle();
    php.syncManagedIniAllVersions();
    versions = [...versions, '8.5'];
    expect(php.isTrustConfigured('8.5')).toBe(false);
    expect(php.syncManagedIniAllVersions()).toEqual(['8.5']);
    expect(php.isTrustConfigured('8.5')).toBe(true);
  });

  it('only rewrites versions whose file differs', () => {
    writeBundle();
    expect(php.syncManagedIniAllVersions()).toEqual(['8.3', '8.4']);
    expect(php.syncManagedIniAllVersions()).toEqual([]);
  });

  it('drops the directives once the bundle is gone', () => {
    writeBundle();
    php.syncManagedIniAllVersions();
    fs.rmSync(bundlePath());
    php.syncManagedIniAllVersions();
    expect(fs.readFileSync(iniPath('8.3'), 'utf8')).not.toContain('openssl.cafile');
    expect(php.isTrustConfigured('8.3')).toBe(false);
  });

  it('creates no file when there is nothing to write', () => {
    php.syncManagedIniAllVersions();
    expect(fs.existsSync(iniPath('8.3'))).toBe(false);
  });
});

describe('setPhpIniSetting', () => {
  it('keeps the certificate directives when a setting changes', () => {
    writeBundle();
    php.syncManagedIniAllVersions();
    php.setPhpIniSetting('8.3', 'memory_limit', 768);
    const text = fs.readFileSync(iniPath('8.3'), 'utf8');
    expect(text).toContain('memory_limit = 768M');
    expect(text).toContain(`openssl.cafile = "${bundlePath()}"`);
  });
});
