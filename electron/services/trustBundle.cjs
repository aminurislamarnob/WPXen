'use strict';

// One CA bundle that PHP and WordPress verify HTTPS against: the public
// authorities (Homebrew's ca-certificates bundle, falling back to the
// system's), followed by the local authority's root (mkcert's rootCA.pem). With
// it, an HTTPS call from one local Site to another — or to itself, as Site
// Health's loopback check does — verifies like any public site, and
// verification is never turned off to get there.
//
// Consumers: the two certificate directives in each PHP version's
// zz-wpxen.ini (php.cjs) and the wpxen-local-trust.php must-use plugin
// (wordpress.cjs), because WordPress's HTTP API ignores PHP's directives.

const fs = require('fs');
const path = require('path');
const brew = require('./brew.cjs');

// Name-carrying, written outside the app bundle: `{prefix}/etc/wpxen/ca-bundle.pem`.
// Under the Homebrew prefix rather than userData for the same reason the FPM
// sockets are (php.cjs FPM_RUN_DIR): "Application Support" has a space, and the
// path is baked into ini files and a PHP string on every Site. A future rename
// moves the folder and adds a LEGACY_ list beside these constants, so the old
// one is deleted rather than orphaned.
const TRUST_DIR_NAME = 'wpxen';
const TRUST_BUNDLE_NAME = 'ca-bundle.pem';

// The system bundle macOS ships (root-owned, world-readable).
const SYSTEM_CA_BUNDLE = '/etc/ssl/cert.pem';

const PEM_CERT = '-----BEGIN CERTIFICATE-----';

function getBundlePath(prefix = brew.getBrewPrefix()) {
  return prefix ? path.join(prefix, 'etc', TRUST_DIR_NAME, TRUST_BUNDLE_NAME) : null;
}

// Where the public authorities come from, best first. The openssl@3 path is a
// symlink to the ca-certificates one on a normal install; it's listed in case
// only openssl is present.
function publicBundleCandidates(prefix = brew.getBrewPrefix()) {
  return [
    ...(prefix
      ? [
          path.join(prefix, 'etc', 'ca-certificates', 'cert.pem'),
          path.join(prefix, 'etc', 'openssl@3', 'cert.pem'),
        ]
      : []),
    SYSTEM_CA_BUNDLE,
  ];
}

function readPem(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.includes(PEM_CERT) ? text : null;
  } catch {
    return null;
  }
}

// The bundle text. Text outside BEGIN/END blocks is ignored by OpenSSL and
// curl, so the source comments are safe to keep.
function buildBundle({ publicPem, publicSource, localRootPem, localSource }) {
  const block = (pem) => `${pem.trim()}\n`;
  return [
    '# Managed by WPXen — rebuilt automatically; edits are overwritten.',
    `# Public authorities: ${publicSource}`,
    '',
    block(publicPem),
    `# WPXen local authority: ${localSource}`,
    block(localRootPem),
  ].join('\n');
}

// Builds the bundle at `bundlePath` from the first readable public source and
// the local root. Rewrites only when the content differs, which is what makes
// it "rebuilt when missing or stale": a deleted file, a new local root, or an
// updated Homebrew bundle all differ. Writes nothing until a local authority
// exists — a bundle of only public roots would trust nothing new.
function writeTrustBundle({ bundlePath, publicSources, localRootPath }) {
  if (!bundlePath) return { ok: false, reason: 'no-prefix' };
  const localRootPem = localRootPath && readPem(localRootPath);
  if (!localRootPem) return { ok: false, reason: 'no-local-authority', path: bundlePath };

  let publicPem = null;
  let publicSource = null;
  for (const candidate of publicSources || []) {
    publicPem = readPem(candidate);
    if (publicPem) {
      publicSource = candidate;
      break;
    }
  }
  if (!publicPem) return { ok: false, reason: 'no-public-bundle', path: bundlePath };

  const text = buildBundle({
    publicPem,
    publicSource,
    localRootPem,
    localSource: localRootPath,
  });
  let current = null;
  try {
    current = fs.readFileSync(bundlePath, 'utf8');
  } catch {}
  if (current === text) return { ok: true, changed: false, path: bundlePath };

  // Write-then-rename so a PHP request mid-rebuild never reads half a file.
  fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
  const tmp = `${bundlePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, bundlePath);
  return { ok: true, changed: true, path: bundlePath };
}

// Seams for tests — vi.mock can't reach CJS modules (see browser.cjs). php,
// wordpress and mkcert are required lazily: php.cjs and wordpress.cjs require
// this module for getBundlePath(), and mkcert.cjs calls syncLocalTrust().
let overrides = {};
const deps = {
  get caRoot() {
    return overrides.caRoot || (() => require('./mkcert.cjs').getCaRoot());
  },
  get publicSources() {
    return overrides.publicSources || (() => publicBundleCandidates());
  },
  get php() {
    return overrides.php || require('./php.cjs');
  },
  get wordpress() {
    return overrides.wordpress || require('./wordpress.cjs');
  },
};

function __setDeps(next) {
  overrides = { ...overrides, ...next };
  for (const key of Object.keys(overrides)) {
    if (overrides[key] === undefined) delete overrides[key];
  }
}

function localRootPath() {
  const caRoot = deps.caRoot();
  return caRoot ? path.join(caRoot, 'rootCA.pem') : null;
}

// Brings everything that reads the bundle in line with the local authority:
// rebuilds the bundle if missing or stale, then rewrites each installed PHP
// version's certificate directives (php.cjs drops them while there is no
// bundle) and, for any `sites` given, the WordPress must-use plugin. Called on
// app start, after the local authority is created, and after a PHP install.
// Each step is best-effort so one failure doesn't block the others.
function syncLocalTrust({ sites = [] } = {}) {
  const result = { bundle: null, phpVersionsChanged: [], sitesChanged: 0 };
  try {
    result.bundle = writeTrustBundle({
      bundlePath: getBundlePath(),
      publicSources: deps.publicSources(),
      localRootPath: localRootPath(),
    });
  } catch (err) {
    result.bundle = { ok: false, reason: err.message };
  }
  try {
    result.phpVersionsChanged = deps.php.syncManagedIniAllVersions();
  } catch {}
  for (const site of sites) {
    try {
      if (site?.path && deps.wordpress.ensureLocalTrustMuPlugin(site.path)) {
        result.sitesChanged += 1;
      }
    } catch {}
  }
  return result;
}

// What Settings' "PHP trusts the local authority" row shows. `current` means
// the bundle holds today's local root (a regenerated CA makes it stale);
// `trusted` needs that plus the directives in every installed PHP version.
function getTrustStatus() {
  const bundlePath = getBundlePath();
  const rootPath = localRootPath();
  const localRootPem = rootPath && readPem(rootPath);
  let bundleText = null;
  try {
    bundleText = bundlePath ? fs.readFileSync(bundlePath, 'utf8') : null;
  } catch {}

  const bundle = bundleText != null;
  const current = !!(bundle && localRootPem && bundleText.includes(localRootPem.trim()));
  let versions = [];
  try {
    versions = deps.php.getTrustDirectiveStatus();
  } catch {}

  return {
    trusted: current && versions.length > 0 && versions.every((v) => v.configured),
    localAuthority: !!localRootPem,
    bundle,
    current,
    path: bundlePath,
    versions,
  };
}

module.exports = {
  TRUST_DIR_NAME,
  TRUST_BUNDLE_NAME,
  SYSTEM_CA_BUNDLE,
  getBundlePath,
  publicBundleCandidates,
  buildBundle,
  writeTrustBundle,
  syncLocalTrust,
  getTrustStatus,
  __setDeps,
};
