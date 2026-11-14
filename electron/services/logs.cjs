'use strict';

const fs = require('fs');
const path = require('path');
const brew = require('./brew.cjs');
const logReader = require('./logReader.cjs');

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

// A page of a Site's log as entries — the newest page, or with `end` (a
// previous page's `pageStart`) the one before it. The parsing and paging
// live in the pure logReader.cjs; this only resolves which file.
function readLogPage(site, kind, { end, levels } = {}) {
  return logReader.readPage(resolveLogPath(site, kind), kind, { end, levels });
}

// Entries per level across the whole of a Site's log (null for the access
// log, which has no levels).
function countLogLevels(site, kind) {
  return logReader.countLevelsAsync(resolveLogPath(site, kind), kind);
}

// A batch of entries matching `query` across the whole file, newest first;
// `end` (a previous batch's `pageStart`) continues with older matches.
function searchLog(site, kind, query, { end, levels } = {}) {
  return logReader.searchLogAsync(resolveLogPath(site, kind), kind, {
    query,
    end,
    levels,
  });
}

// Empties a log file in place (truncate, not delete — nginx/php-fpm keep the
// file handle open, so deleting would detach their writes until a reload).
function clearLog(site, kind) {
  const p = resolveLogPath(site, kind);
  if (!fs.existsSync(p)) return;
  fs.truncateSync(p, 0);
}

module.exports = {
  LOG_KINDS,
  resolveLogPath,
  readLogPage,
  countLogLevels,
  searchLog,
  clearLog,
};
