'use strict';

// Local HTTPS support via mkcert: a locally-trusted certificate authority whose
// root is added to the system trust store, so per-site certs are trusted by the
// browser with no warnings (the same approach Laravel Herd uses).

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

// Installs the mkcert local CA into the trust store. Idempotent — a no-op once
// the root is trusted.
//
// `mkcert -install` can't do the macOS step itself from here: it runs
// `sudo security add-trusted-cert -d`, and an app launched from Finder has no
// terminal for sudo to prompt on ("failed to execute \"security
// add-trusted-cert\": exit status 1"). Running that as root behind the admin
// dialog doesn't work either — macOS refuses admin-domain trust changes from a
// process with no UI ("The authorization was denied since no user interaction
// was possible"). So the CA is created as the user (TRUST_STORES=nss skips the
// system store but still covers Firefox) and trusted in the *user* domain via
// the login keychain, which shows macOS's own trust-settings prompt and is
// honoured by Safari, Chrome and anything else on the system keychain APIs.
function ensureCA() {
  const mkcert = getMkcertPath();
  if (!mkcert) throw new Error('mkcert is not installed.');
  if (isCaTrusted()) return;

  execFileSync(mkcert, ['-install'], {
    stdio: 'pipe',
    env: { ...process.env, TRUST_STORES: 'nss' },
  });
  const caRoot = getCaRoot();
  if (!caRoot || !fs.existsSync(`${caRoot}/rootCA.pem`)) {
    throw new Error('mkcert did not create its local certificate authority.');
  }

  try {
    execFileSync('security', userTrustArgs(caRoot, os.homedir()), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = String(err.stderr || err.message || '').trim();
    throw new Error(
      `macOS did not trust the local certificate authority${detail ? `: ${detail}` : '.'}`
    );
  }

  if (!isCaTrusted()) {
    throw new Error('The local certificate authority was not trusted by macOS.');
  }

  // A new (or re-created) root means PHP's trust bundle is stale: rebuild it
  // and point every PHP version at it. Lazily required — trustBundle.cjs reaches
  // back here for getCaRoot(). Never fails the HTTPS switch that got us here.
  try {
    require('./trustBundle.cjs').syncLocalTrust();
  } catch {}
}

// `security` arguments that trust the CA root for the current user.
function userTrustArgs(caRoot, home) {
  return [
    'add-trusted-cert',
    '-r',
    'trustRoot',
    '-k',
    path.join(home, 'Library/Keychains/login.keychain-db'),
    path.join(caRoot, 'rootCA.pem'),
  ];
}

// Whether mkcert's local authority exists on disk (trusted or not). mkcert
// silently creates a fresh root when it's missing, so a caller that must not
// change trust (the silent re-issue in migration.cjs) checks this first.
function hasCa() {
  const caRoot = getCaRoot();
  return !!caRoot && fs.existsSync(`${caRoot}/rootCA.pem`);
}

// Whether macOS actually trusts mkcert's root — not merely whether the file
// exists, which it does even after a failed keychain step.
function isCaTrusted() {
  if (!hasCa()) return false;
  const caRoot = getCaRoot();
  try {
    execFileSync('security', ['verify-cert', '-c', `${caRoot}/rootCA.pem`], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

// `mkcert` arguments for one Site certificate: the domain and its wildcard, so
// `sub.shop.test` is covered too (subdomain multisite; the vhost answers to
// `*.domain` as well, nginx.cjs). A wildcard covers one label, which is all a
// subdomain network needs. `domain` is validated to a safe charset that can't
// start with `-`, so it's never able to smuggle an extra mkcert argument even
// though we already avoid a shell.
function certArgs(domain, certPath, keyPath) {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(domain)) {
    throw new Error(`Unsafe domain for certificate: ${domain}`);
  }
  return ['-cert-file', certPath, '-key-file', keyPath, domain, `*.${domain}`];
}

// Generates (or overwrites) a trusted cert + key for `domain` and its
// wildcard. Returns their absolute paths, keyed on the bare domain — the same
// two files whatever names the cert covers, so re-issuing leaves no orphans.
// Prompt-free: only ensureCA() touches a trust store.
function generateCert(domain) {
  certArgs(domain); // validate before touching the filesystem
  const mkcert = getMkcertPath();
  if (!mkcert) throw new Error('mkcert is not installed.');
  const dir = getCertDir();
  if (!dir) throw new Error('Could not resolve the certificate directory.');

  const certPath = `${dir}/${domain}.pem`;
  const keyPath = `${dir}/${domain}-key.pem`;
  execFileSync(mkcert, certArgs(domain, certPath, keyPath), { stdio: 'pipe' });
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

// Read-only status for the Settings CA row: is mkcert present, and does macOS
// trust its local root CA?
function getCaStatus() {
  if (!isInstalled()) return { installed: false, trusted: false, caRoot: null };
  return { installed: true, trusted: isCaTrusted(), caRoot: getCaRoot() };
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
  hasCa,
  isCaTrusted,
  userTrustArgs,
  certArgs,
  generateCert,
  removeCert,
  getCaRoot,
  getCaStatus,
};
