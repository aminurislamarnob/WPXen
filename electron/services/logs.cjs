'use strict';

const fs = require('fs');
const path = require('path');
const brew = require('./brew.cjs');

// How much of a log file to show: the last 256 KB is plenty for a viewer and
// keeps huge access logs from flooding the IPC channel.
const MAX_READ_BYTES = 256 * 1024;

const LOG_KINDS = ['debug', 'nginx-error', 'nginx-access', 'php-error'];

// Resolves the absolute path of a site's log file. `debug` and the nginx pair
// are per-site; the PHP-FPM error log is global to the running PHP version.
function resolveLogPath(site, kind) {
  if (!LOG_KINDS.includes(kind)) {
    throw new Error(`Unknown log type: ${kind}`);
  }
  // The domain is validated at site creation; re-check before using it in a
  // filesystem path as a last line of defense.
  if (!/^[a-z0-9.-]+$/.test(site.domain || '')) {
    throw new Error('Invalid site domain.');
  }
  const prefix = brew.getBrewPrefix();
  switch (kind) {
    case 'debug':
      return path.join(site.path, 'wp-content', 'debug.log');
    case 'nginx-error':
      return `${prefix}/var/log/nginx/${site.domain}.error.log`;
    case 'nginx-access':
      return `${prefix}/var/log/nginx/${site.domain}.access.log`;
    case 'php-error':
      return `${prefix}/var/log/php-fpm.log`;
    default:
      throw new Error(`Unknown log type: ${kind}`);
  }
}

// Reads the tail of a log file (last MAX_READ_BYTES). Returns exists=false
// rather than throwing when the file isn't there yet — that's a normal state
// (e.g. debug.log before WP_DEBUG_LOG is enabled).
function readLog(site, kind) {
  const p = resolveLogPath(site, kind);
  if (!fs.existsSync(p)) {
    return { path: p, exists: false, content: '', size: 0, truncated: false };
  }

  const stat = fs.statSync(p);
  const start = Math.max(0, stat.size - MAX_READ_BYTES);
  const length = stat.size - start;

  let content = '';
  if (length > 0) {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, start);
      content = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }

  const truncated = start > 0;
  if (truncated) {
    // Drop the likely-partial first line so the view starts on a clean entry.
    const nl = content.indexOf('\n');
    if (nl !== -1) content = content.slice(nl + 1);
  }

  return { path: p, exists: true, content, size: stat.size, truncated };
}

// Empties a log file in place (truncate, not delete — nginx/php-fpm keep the
// file handle open, so deleting would detach their writes until a reload).
function clearLog(site, kind) {
  const p = resolveLogPath(site, kind);
  if (!fs.existsSync(p)) return;
  fs.truncateSync(p, 0);
}

module.exports = { LOG_KINDS, resolveLogPath, readLog, clearLog };
