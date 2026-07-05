'use strict';

// Local HTTPS support via mkcert: a locally-trusted certificate authority whose
// root is added to the system trust store, so per-site certs are trusted by the
// browser with no warnings (the same approach Laravel Herd uses).

const { execFileSync } = require('child_process');
const fs = require('fs');
const brew = require('./brew.cjs');

function getMkcertPath() {
  const prefix = brew.getBrewPrefix();
  if (prefix && fs.existsSync(`${prefix}/bin/mkcert`)) {
    return `${prefix}/bin/mkcert`;
  }
  return null;
}

function isInstalled() {
  return getMkcertPath() !== null;
}

// Installs mkcert via Homebrew if it isn't already present. Has a bottle, so
// this is quick and needs no sudo.
function ensureInstalled() {
  if (isInstalled()) return;
  brew.execBrew('install mkcert');
  if (!isInstalled()) {
    throw new Error('Failed to install mkcert via Homebrew.');
  }
}

// Per-site certs live alongside the nginx config so the vhosts are
// self-contained. On Apple Silicon the Homebrew prefix is user-writable.
function getCertDir() {
  const prefix = brew.getBrewPrefix();
  if (!prefix) return null;
  const dir = `${prefix}/etc/nginx/certs`;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// Installs the mkcert local CA into the system trust store. Idempotent — a
// no-op if already installed. The first run may show a macOS admin prompt to
// add the root certificate to the keychain.
function ensureCA() {
  const mkcert = getMkcertPath();
  if (!mkcert) throw new Error('mkcert is not installed.');
  execFileSync(mkcert, ['-install'], { stdio: 'pipe' });
}

// Generates (or overwrites) a trusted cert + key for `domain`. Returns their
// absolute paths. `domain` is validated to a safe charset so it's never able to
// smuggle extra mkcert arguments even though we already avoid a shell.
function generateCert(domain) {
  if (!/^[a-z0-9.-]+$/.test(domain)) {
    throw new Error(`Unsafe domain for certificate: ${domain}`);
  }
  const mkcert = getMkcertPath();
  if (!mkcert) throw new Error('mkcert is not installed.');
  const dir = getCertDir();
  if (!dir) throw new Error('Could not resolve the certificate directory.');

  const certPath = `${dir}/${domain}.pem`;
  const keyPath = `${dir}/${domain}-key.pem`;
  execFileSync(mkcert, ['-cert-file', certPath, '-key-file', keyPath, domain], {
    stdio: 'pipe',
  });
  return { certPath, keyPath };
}

// Absolute path to mkcert's CA directory (holds rootCA.pem / rootCA-key.pem),
// or null if mkcert isn't installed.
function getCaRoot() {
  const mkcert = getMkcertPath();
  if (!mkcert) return null;
  try {
    const out = execFileSync(mkcert, ['-CAROOT'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString().trim() || null;
  } catch {
    return null;
  }
}

// Read-only status for the Settings CA row: is mkcert present, and has its
// local root CA been generated (and therefore installed into the trust store)?
function getCaStatus() {
  if (!isInstalled()) return { installed: false, trusted: false, caRoot: null };
  const caRoot = getCaRoot();
  const trusted = !!(caRoot && fs.existsSync(`${caRoot}/rootCA.pem`));
  return { installed: true, trusted, caRoot };
}

function removeCert(domain) {
  const dir = getCertDir();
  if (!dir) return;
  for (const p of [`${dir}/${domain}.pem`, `${dir}/${domain}-key.pem`]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
  }
}

module.exports = {
  getMkcertPath,
  isInstalled,
  ensureInstalled,
  getCertDir,
  ensureCA,
  generateCert,
  removeCert,
  getCaRoot,
  getCaStatus,
};
