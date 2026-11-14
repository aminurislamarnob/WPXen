import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Loaded through Node's require so the stubs reach the same module instances
// trustBundle.cjs / php.cjs require internally (see per-site-php.test.js).
const require = createRequire(import.meta.url);
const brew = require('../electron/services/brew.cjs');
const php = require('../electron/services/php.cjs');
const trustBundle = require('../electron/services/trustBundle.cjs');

// One trust bundle: the public authorities first, then the local authority's
// root. PHP and WordPress both read it, so its contents are what decides
// whether an HTTPS call to another local Site verifies.

const PUBLIC_PEM =
  '-----BEGIN CERTIFICATE-----\nPUBLICROOTONE\n-----END CERTIFICATE-----\n' +
  '-----BEGIN CERTIFICATE-----\nPUBLICROOTTWO\n-----END CERTIFICATE-----\n';
const SYSTEM_PEM = '-----BEGIN CERTIFICATE-----\nSYSTEMROOT\n-----END CERTIFICATE-----\n';
const rootPem = (body) =>
  `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-trust-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fixture() {
  const homebrew = path.join(tmp, 'brew-cert.pem');
  const system = path.join(tmp, 'system-cert.pem');
  const caRoot = path.join(tmp, 'mkcert');
  fs.mkdirSync(caRoot);
  fs.writeFileSync(homebrew, PUBLIC_PEM);
  fs.writeFileSync(system, SYSTEM_PEM);
  fs.writeFileSync(path.join(caRoot, 'rootCA.pem'), rootPem('LOCALROOTA'));
  return {
    bundlePath: path.join(tmp, 'out', 'ca-bundle.pem'),
    publicSources: [homebrew, system],
    localRootPath: path.join(caRoot, 'rootCA.pem'),
    homebrew,
    caRoot,
  };
}

describe('writeTrustBundle', () => {
  it('holds the public authorities followed by the local root', () => {
    const f = fixture();
    const res = trustBundle.writeTrustBundle(f);
    expect(res).toMatchObject({ ok: true, changed: true, path: f.bundlePath });

    const text = fs.readFileSync(f.bundlePath, 'utf8');
    expect(text).toContain('PUBLICROOTONE');
    expect(text).toContain('PUBLICROOTTWO');
    expect(text).toContain('LOCALROOTA');
    expect(text.indexOf('PUBLICROOTTWO')).toBeLessThan(text.indexOf('LOCALROOTA'));
    // Homebrew's bundle wins; the system one is only a fallback.
    expect(text).not.toContain('SYSTEMROOT');
  });

  it("falls back to the system bundle when Homebrew's is missing", () => {
    const f = fixture();
    fs.rmSync(f.homebrew);
    trustBundle.writeTrustBundle(f);
    const text = fs.readFileSync(f.bundlePath, 'utf8');
    expect(text).toContain('SYSTEMROOT');
    expect(text).toContain('LOCALROOTA');
  });

  it('is rebuilt when the local root changes', () => {
    const f = fixture();
    trustBundle.writeTrustBundle(f);
    expect(trustBundle.writeTrustBundle(f).changed).toBe(false);

    fs.writeFileSync(f.localRootPath, rootPem('LOCALROOTB'));
    expect(trustBundle.writeTrustBundle(f).changed).toBe(true);
    const text = fs.readFileSync(f.bundlePath, 'utf8');
    expect(text).toContain('LOCALROOTB');
    expect(text).not.toContain('LOCALROOTA');
  });

  it('is rebuilt when the file was deleted', () => {
    const f = fixture();
    trustBundle.writeTrustBundle(f);
    fs.rmSync(f.bundlePath);
    expect(trustBundle.writeTrustBundle(f).changed).toBe(true);
    expect(fs.existsSync(f.bundlePath)).toBe(true);
  });

  it('writes nothing until a local authority exists', () => {
    const f = fixture();
    fs.rmSync(f.localRootPath);
    const res = trustBundle.writeTrustBundle(f);
    expect(res.ok).toBe(false);
    expect(fs.existsSync(f.bundlePath)).toBe(false);
  });

  it('writes nothing when no public bundle can be found', () => {
    const f = fixture();
    const res = trustBundle.writeTrustBundle({ ...f, publicSources: [] });
    expect(res.ok).toBe(false);
    expect(fs.existsSync(f.bundlePath)).toBe(false);
  });
});

describe('getBundlePath', () => {
  it('lives in a wpxen folder under the Homebrew prefix', () => {
    expect(trustBundle.getBundlePath('/opt/homebrew')).toBe(
      '/opt/homebrew/etc/wpxen/ca-bundle.pem'
    );
    expect(trustBundle.getBundlePath(null)).toBe(null);
  });

  it("prefers Homebrew's CA bundle and falls back to the system one", () => {
    const list = trustBundle.publicBundleCandidates('/usr/local');
    expect(list[0]).toBe('/usr/local/etc/ca-certificates/cert.pem');
    expect(list[list.length - 1]).toBe('/etc/ssl/cert.pem');
  });
});

describe('syncLocalTrust + getTrustStatus', () => {
  const saved = {};
  let f;
  let versions;

  beforeEach(() => {
    f = fixture();
    saved.getBrewPrefix = brew.getBrewPrefix;
    brew.getBrewPrefix = () => tmp;
    versions = ['8.3', '8.4'];
    php.__setDeps({
      installedVersions: () => versions,
      procman: { status: () => ({ state: 'stopped' }), isSupervised: () => false },
    });
    trustBundle.__setDeps({
      caRoot: () => f.caRoot,
      publicSources: () => f.publicSources,
    });
  });

  afterEach(() => {
    brew.getBrewPrefix = saved.getBrewPrefix;
    php.__setDeps({
      installedVersions: () => brew.getInstalledPhpVersions(),
      procman: require('../electron/services/procman.cjs'),
    });
    trustBundle.__setDeps({ caRoot: undefined, publicSources: undefined });
  });

  it('reports trusted once the bundle and every version are in place', () => {
    expect(trustBundle.getTrustStatus().trusted).toBe(false);
    trustBundle.syncLocalTrust();
    const status = trustBundle.getTrustStatus();
    expect(status).toMatchObject({ trusted: true, bundle: true, current: true });
    expect(status.versions).toEqual([
      { version: '8.3', configured: true },
      { version: '8.4', configured: true },
    ]);
  });

  it('reflects reality when the bundle is deleted', () => {
    trustBundle.syncLocalTrust();
    fs.rmSync(trustBundle.getBundlePath(tmp));
    expect(trustBundle.getTrustStatus()).toMatchObject({ trusted: false, bundle: false });
  });

  it('reports stale when the local root changed since the last build', () => {
    trustBundle.syncLocalTrust();
    fs.writeFileSync(f.localRootPath, rootPem('LOCALROOTB'));
    expect(trustBundle.getTrustStatus()).toMatchObject({
      trusted: false,
      current: false,
    });
    trustBundle.syncLocalTrust();
    expect(trustBundle.getTrustStatus().trusted).toBe(true);
  });

  it('covers a PHP version installed later', () => {
    trustBundle.syncLocalTrust();
    versions = ['8.3', '8.4', '8.5'];
    expect(trustBundle.getTrustStatus().trusted).toBe(false);
    trustBundle.syncLocalTrust();
    expect(trustBundle.getTrustStatus().trusted).toBe(true);
  });

  it('reports no local authority before HTTPS was ever enabled', () => {
    fs.rmSync(f.localRootPath);
    trustBundle.syncLocalTrust();
    expect(trustBundle.getTrustStatus()).toMatchObject({
      trusted: false,
      localAuthority: false,
    });
  });

  it('writes the WordPress must-use plugin for every Site it is given', () => {
    const sitePath = path.join(tmp, 'site');
    fs.mkdirSync(path.join(sitePath, 'wp-content'), { recursive: true });
    trustBundle.syncLocalTrust({ sites: [{ path: sitePath }, { path: '/nope' }] });
    expect(
      fs.existsSync(path.join(sitePath, 'wp-content/mu-plugins/wpxen-local-trust.php'))
    ).toBe(true);
  });
});
