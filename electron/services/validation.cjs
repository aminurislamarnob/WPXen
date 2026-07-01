'use strict';

const path = require('path');

// Server-side validation for site-creation input. This is the security
// boundary — the renderer's form validation is only a convenience and must
// never be trusted. Combined with execFile-based command execution (no shell),
// these rules keep user input from reaching a shell, SQL identifier, or nginx
// config in a dangerous form.

// Hostname labels: letters/digits/hyphens, not starting/ending with a hyphen,
// dot-separated. Deliberately excludes anything a shell or nginx config could
// interpret (spaces, quotes, $, ;, newlines, braces, slashes).
const DOMAIN_RE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

// MySQL identifier: our own generated names are [a-z0-9_]; allow that only.
const DB_NAME_RE = /^[a-zA-Z0-9_]{1,64}$/;

const PHP_VERSION_RE = /^\d+\.\d+$/;

// WordPress usernames are fairly permissive but must not contain shell/space
// metacharacters that could matter elsewhere.
const WP_USER_RE = /^[a-zA-Z0-9_.@-]{1,60}$/;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function validateSiteInput(data = {}) {
  const errors = [];

  if (!isNonEmptyString(data.name)) {
    errors.push('Site name is required.');
  } else if (data.name.length > 100) {
    errors.push('Site name must be 100 characters or fewer.');
  }

  if (!isNonEmptyString(data.domain)) {
    errors.push('Domain is required.');
  } else if (data.domain.length > 253 || !DOMAIN_RE.test(data.domain)) {
    errors.push('Domain may only contain lowercase letters, numbers, hyphens and dots.');
  }

  if (!isNonEmptyString(data.dbName)) {
    errors.push('Database name is required.');
  } else if (!DB_NAME_RE.test(data.dbName)) {
    errors.push('Database name may only contain letters, numbers and underscores (max 64).');
  }

  if (!isNonEmptyString(data.path)) {
    errors.push('Site directory is required.');
  } else if (!path.isAbsolute(data.path)) {
    errors.push('Site directory must be an absolute path.');
  } else if (/[\n\r\0]/.test(data.path)) {
    errors.push('Site directory contains invalid characters.');
  }

  if (!isNonEmptyString(data.phpVersion) || !PHP_VERSION_RE.test(data.phpVersion)) {
    errors.push('A valid PHP version (e.g. 8.2) is required.');
  }

  if (data.adminUser != null && !WP_USER_RE.test(String(data.adminUser))) {
    errors.push('Admin username may only contain letters, numbers and . _ @ - characters.');
  }

  if (data.adminEmail != null && data.adminEmail !== '' && !EMAIL_RE.test(String(data.adminEmail))) {
    errors.push('Admin email is not a valid email address.');
  }

  if (data.adminPassword != null) {
    const pw = String(data.adminPassword);
    if (pw.length < 1) errors.push('Admin password is required.');
    else if (pw.length > 200) errors.push('Admin password is too long.');
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  validateSiteInput,
  DOMAIN_RE,
  DB_NAME_RE,
  PHP_VERSION_RE,
  WP_USER_RE,
  EMAIL_RE,
};
