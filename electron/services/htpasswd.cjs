'use strict';

// Basic-auth support for share tunnels. Generates Apache apr1 (MD5-crypt)
// password hashes — the scheme nginx's auth_basic_user_file verifies natively —
// and manages per-site htpasswd files.
//
// The htpasswd files live under the Homebrew nginx etc dir (not userData):
// the userData path contains a space ("Application Support"), which would need
// quoting inside the nginx directive, while the brew prefix is space-free and
// colocated with the vhosts nginx already reads. Plaintext passwords are never
// persisted anywhere — only the salted hash on disk.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const brew = require('./brew.cjs');

// crypt(3) base64 alphabet — NOT standard base64.
const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function md5(buf) {
  return crypto.createHash('md5').update(buf).digest();
}

function to64(value, chars) {
  let out = '';
  while (chars-- > 0) {
    out += ITOA64[value & 0x3f];
    value >>>= 6;
  }
  return out;
}

// Apache's apr1 MD5-crypt. Salt is 1–8 chars from the crypt alphabet.
// Deterministic for a given (password, salt) so it's testable against
// `openssl passwd -apr1 -salt <salt> <password>`.
function apr1Hash(password, salt) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password must be a non-empty string');
  }
  if (typeof salt !== 'string' || !/^[./0-9A-Za-z]{1,8}$/.test(salt)) {
    throw new Error('Salt must be 1-8 characters from the crypt alphabet');
  }

  const pw = Buffer.from(password, 'utf8');
  const sl = Buffer.from(salt, 'utf8');

  // Alternate sum: md5(password + salt + password).
  let final = md5(Buffer.concat([pw, sl, pw]));

  // Main context: password + "$apr1$" + salt, then the alternate sum repeated
  // to cover the password length, then one bit of the length per iteration.
  const parts = [pw, Buffer.from('$apr1$'), sl];
  for (let i = pw.length; i > 0; i -= 16) {
    parts.push(final.subarray(0, Math.min(16, i)));
  }
  for (let i = pw.length; i > 0; i >>= 1) {
    parts.push(i & 1 ? Buffer.from([0]) : pw.subarray(0, 1));
  }
  final = md5(Buffer.concat(parts));

  // 1000 rounds of stretching.
  for (let i = 0; i < 1000; i++) {
    const round = [];
    round.push(i & 1 ? pw : final);
    if (i % 3) round.push(sl);
    if (i % 7) round.push(pw);
    round.push(i & 1 ? final : pw);
    final = md5(Buffer.concat(round));
  }

  // Digest bytes are emitted in crypt(3)'s scrambled order.
  let hash = '';
  hash += to64((final[0] << 16) | (final[6] << 8) | final[12], 4);
  hash += to64((final[1] << 16) | (final[7] << 8) | final[13], 4);
  hash += to64((final[2] << 16) | (final[8] << 8) | final[14], 4);
  hash += to64((final[3] << 16) | (final[9] << 8) | final[15], 4);
  hash += to64((final[4] << 16) | (final[10] << 8) | final[5], 4);
  hash += to64(final[11], 2);

  return `$apr1$${salt}$${hash}`;
}

function randomSalt() {
  const bytes = crypto.randomBytes(8);
  let salt = '';
  for (const b of bytes) salt += ITOA64[b & 0x3f];
  return salt;
}

// A username we're willing to write into an htpasswd file. `:` would terminate
// the user field; newlines would inject extra entries.
function isValidAuthUser(user) {
  return typeof user === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(user);
}

function htpasswdLine(user, password, salt = randomSalt()) {
  if (!isValidAuthUser(user)) {
    throw new Error('Username may only contain letters, digits, ".", "_" and "-".');
  }
  return `${user}:${apr1Hash(password, salt)}`;
}

function getHtpasswdDir() {
  const prefix = brew.getBrewPrefix();
  if (!prefix) throw new Error('Homebrew is not installed.');
  return path.join(prefix, 'etc', 'nginx', 'wpherd-htpasswd');
}

// Domain doubles as the filename — validated like nginx.cjs validates it so a
// tampered store value can't traverse out of the htpasswd dir.
function getHtpasswdPath(domain) {
  if (typeof domain !== 'string' || !/^[a-z0-9.-]+$/.test(domain) || domain.includes('..')) {
    throw new Error(`Unsafe domain for htpasswd file: ${domain}`);
  }
  return path.join(getHtpasswdDir(), `${domain}.htpasswd`);
}

function hasHtpasswdFile(domain) {
  try {
    return fs.existsSync(getHtpasswdPath(domain));
  } catch {
    return false;
  }
}

function writeHtpasswdFile(domain, user, password) {
  const file = getHtpasswdPath(domain);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, htpasswdLine(user, password) + '\n', { mode: 0o600 });
  return file;
}

function removeHtpasswdFile(domain) {
  try {
    fs.unlinkSync(getHtpasswdPath(domain));
  } catch {
    // Already absent — fine.
  }
}

// Returns a copy of the site with `shareAuthFile` attached when basic-auth is
// enabled and the htpasswd file actually exists — the transient field
// nginx.generateSiteConfig uses to protect the tunnel alias server block.
function attachShareAuth(site) {
  if (site?.share?.authEnabled && hasHtpasswdFile(site.domain)) {
    return { ...site, shareAuthFile: getHtpasswdPath(site.domain) };
  }
  return site;
}

module.exports = {
  apr1Hash,
  randomSalt,
  isValidAuthUser,
  htpasswdLine,
  getHtpasswdPath,
  hasHtpasswdFile,
  writeHtpasswdFile,
  removeHtpasswdFile,
  attachShareAuth,
};
