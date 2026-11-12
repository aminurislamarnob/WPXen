'use strict';

// Reads a log file as entries, a page at a time. Pure: a file path and a log
// kind in, plain data out — no store, no brew prefix, no electron — so the
// same functions can serve the Logs page, tests against temp fixtures, and
// later the Agent control plane.
//
// An entry is a header line plus every continuation line after it, so a PHP
// fatal keeps its stack trace. A page is read backwards from a byte offset
// (the end of the file by default) and always starts on an entry start, so
// paging back to the start of a file never splits or repeats an entry.

const fs = require('fs');

// ── Limits ─────────────────────────────────────────────────────────────────
// Everything a page holds crosses IPC, so a page is capped both by entry
// count and by the text it carries.
const PAGE_MAX_ENTRIES = 500;
const PAGE_MAX_BYTES = 1024 * 1024;
// One entry's text. A run of lines with no header this long (a log written
// without timestamps, a huge print_r) is cut at a line boundary into parts
// flagged `partial`, the only way an entry ever spans two pages. It also
// bounds the scan, so opening a 200 MB file reads O(page), never the file.
const ENTRY_MAX_BYTES = 256 * 1024;
const READ_CHUNK = 64 * 1024;
// How much of a line the header test looks at.
const HEAD_BYTES = 256;

const LEVELS = ['fatal', 'warning', 'notice', 'deprecated', 'other'];
const SEVERITY = { fatal: 4, warning: 3, notice: 2, deprecated: 1 };

// ── Formats ────────────────────────────────────────────────────────────────
// `PHP Fatal error:` / `PHP Warning:` … — the prefix PHP's error_log puts on
// every message, also quoted inside PHP-FPM ("child said into stderr") and
// nginx ("FastCGI sent in stderr: PHP message: …") lines.
const PHP_LEVEL_RE =
  /PHP (Fatal error|Parse error|Recoverable fatal error|Catchable fatal error|Warning|Notice|Deprecated|Strict Standards):/g;

function phpLevel(label) {
  if (/fatal|parse/i.test(label)) return 'fatal';
  if (label === 'Warning') return 'warning';
  if (label === 'Deprecated') return 'deprecated';
  return 'notice'; // Notice, Strict Standards
}

// The most severe PHP message quoted anywhere in `text`, or null.
function embeddedPhpLevel(text) {
  let best = null;
  for (const m of text.matchAll(PHP_LEVEL_RE)) {
    const level = phpLevel(m[1]);
    if (!best || SEVERITY[level] > SEVERITY[best]) best = level;
  }
  return best;
}

// PHP's error_log line: `[12-Nov-2026 10:00:00 UTC] PHP Warning:  …`. The
// zone is whatever date.timezone says (WordPress forces UTC); PHP-FPM's own
// log writes the same bracket without one, then `NOTICE: …`.
const PHP_HEADER_RE = /^\[(\d{1,2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}:\d{2}[^\]]*)\] ?/;

// PHP-FPM's own levels (log_level), normalised the way nginx's are: error
// and above means something broke.
const FPM_LEVELS = {
  ALERT: 'fatal',
  ERROR: 'fatal',
  WARNING: 'warning',
  NOTICE: 'notice',
  DEBUG: 'other',
};

const NGINX_ERROR_HEADER_RE =
  /^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}) \[(debug|info|notice|warn|error|crit|alert|emerg)\] /;
const NGINX_LEVELS = {
  emerg: 'fatal',
  alert: 'fatal',
  crit: 'fatal',
  error: 'fatal',
  warn: 'warning',
  notice: 'notice',
  info: 'notice',
  debug: 'other',
};

// The `combined` format's `[12/Nov/2026:10:00:00 +0000]`.
const ACCESS_TIME_RE = /\[(\d{2}\/[A-Za-z]{3}\/\d{4}:\d{2}:\d{2}:\d{2} [+-]\d{4})\]/;

// Per log kind: `isHeader(head)` says whether a line starts an entry (given
// its first HEAD_BYTES), `parse(firstLine)` returns its `{ time, level,
// text }`, `text` being the line with any leading timestamp removed (it's
// shown in its own column). `levels: false` marks a log with no levels.
const FORMATS = {
  debug: {
    levels: true,
    isHeader: (head) => PHP_HEADER_RE.test(head),
    parse(line) {
      const m = PHP_HEADER_RE.exec(line);
      const text = line.slice(m[0].length);
      const label = /^PHP ([A-Za-z ]+?):/.exec(text);
      return { time: m[1], level: label ? phpLevel(label[1]) : 'other', text };
    },
  },
  'php-error': {
    levels: true,
    isHeader: (head) => PHP_HEADER_RE.test(head),
    parse(line) {
      const m = PHP_HEADER_RE.exec(line);
      const text = line.slice(m[0].length);
      // PHP-FPM's own line, possibly quoting a worker's PHP message; or a
      // PHP message written straight to the file by PHP's error_log.
      const fpm = /^([A-Z]+): /.exec(text);
      const level = embeddedPhpLevel(text) || (fpm && FPM_LEVELS[fpm[1]]) || 'other';
      return { time: m[1], level, text };
    },
  },
  'nginx-error': {
    levels: true,
    isHeader: (head) => NGINX_ERROR_HEADER_RE.test(head),
    parse(line) {
      const m = NGINX_ERROR_HEADER_RE.exec(line);
      const text = line.slice(m[1].length + 1);
      // A PHP message relayed through FastCGI is as severe as PHP says, not
      // as nginx's blanket `[error]` says.
      return { time: m[1], level: embeddedPhpLevel(text) || NGINX_LEVELS[m[2]], text };
    },
  },
  'nginx-access': {
    levels: false,
    isHeader: () => true, // one request per line
    parse(line) {
      const m = ACCESS_TIME_RE.exec(line);
      return { time: m ? m[1] : null, level: null, text: line };
    },
  },
};

function formatFor(kind) {
  const format = FORMATS[kind];
  if (!format) throw new Error(`Unknown log type: ${kind}`);
  return format;
}

// ── Backward reading ───────────────────────────────────────────────────────
// A window onto [start, start + buf.length) of the file that only ever grows
// downwards, one READ_CHUNK at a time, and is trimmed from the top once an
// entry is emitted — it holds at most one entry plus a chunk.
function backwardWindow(fd, end) {
  let start = end;
  let buf = Buffer.alloc(0);
  return {
    // The position of the last newline in [floor, to), or -1.
    lastNewline(to, floor) {
      let hi = to;
      for (;;) {
        const lo = Math.max(floor, start);
        if (hi > lo) {
          const i = buf.lastIndexOf(0x0a, hi - 1 - start);
          if (i !== -1 && start + i >= lo) return start + i;
        }
        if (start <= floor) return -1;
        hi = Math.min(hi, start);
        const chunkStart = Math.max(0, start - READ_CHUNK);
        // Zero-filled to full length, so a file that shrank mid-read can't
        // shift offsets.
        const chunk = Buffer.alloc(start - chunkStart);
        fs.readSync(fd, chunk, 0, chunk.length, chunkStart);
        buf = Buffer.concat([chunk, buf]);
        start = chunkStart;
      }
    },
    slice: (from, to) => buf.subarray(from - start, to - start),
    trimTo(to) {
      if (to - start < buf.length) buf = buf.subarray(0, to - start);
    },
  };
}

function toEntry(format, offset, bytes, partial) {
  let raw = bytes.toString('utf8');
  if (raw.endsWith('\n')) raw = raw.slice(0, -1);
  if (raw.endsWith('\r')) raw = raw.slice(0, -1);
  const nl = raw.indexOf('\n');
  const first = (nl === -1 ? raw : raw.slice(0, nl)).replace(/\r$/, '');
  const rest = nl === -1 ? '' : raw.slice(nl);
  if (partial) {
    // Its header is in the entry before it (or rotated away).
    return {
      offset,
      time: null,
      level: format.levels ? 'other' : null,
      text: raw,
      partial,
    };
  }
  const { time, level, text } = format.parse(first);
  return { offset, time, level, text: text + rest };
}

// The page of whole entries ending at `end`, newest last. `pageStart` is
// where the next older page ends.
function readEntriesBefore(fd, end, format) {
  const win = backwardWindow(fd, end);
  const newestFirst = [];
  let bytes = 0;
  let entryEnd = end; // end of the entry being assembled
  let cursor = end; // start of its oldest line found so far

  const emit = (from, partial) => {
    newestFirst.push(toEntry(format, from, win.slice(from, entryEnd), partial));
    bytes += entryEnd - from;
    entryEnd = from;
    win.trimTo(entryEnd);
    return newestFirst.length >= PAGE_MAX_ENTRIES || bytes >= PAGE_MAX_BYTES;
  };

  while (cursor > 0) {
    // `cursor` sits just past the newline ending the line above it, so the
    // search for that line's start begins one byte lower.
    const floor = Math.max(0, entryEnd - ENTRY_MAX_BYTES);
    const nl = win.lastNewline(cursor - 1, floor);
    if (nl === -1 && floor > 0) {
      // No header within the cap: cut at the oldest whole line, or — a
      // single line longer than the cap — at the cap itself.
      if (emit(cursor < entryEnd ? cursor : floor, true)) break;
      cursor = entryEnd;
      continue;
    }
    const lineStart = nl + 1; // 0 when the file's first line is reached
    const head = win.slice(lineStart, Math.min(cursor, lineStart + HEAD_BYTES));
    const isHeader = format.isHeader(head.toString('utf8'));
    cursor = lineStart;
    if ((isHeader || lineStart === 0) && emit(lineStart, !isHeader)) break;
  }

  return { entries: newestFirst.reverse(), pageStart: entryEnd };
}

// ── Public ─────────────────────────────────────────────────────────────────

// A page of entries ending at byte offset `end` — the newest page when it's
// omitted; pass a previous page's `pageStart` for the one before it. Returns
// { path, exists, size, entries, pageStart, end, atStart }; each entry is
// { offset, time, level, text, partial? }, `offset` unique within the file.
// A missing file is `exists: false`, a normal state (debug.log before
// WP_DEBUG_LOG is on), not an error.
function readPage(filePath, kind, { end } = {}) {
  const format = formatFor(kind);
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        path: filePath,
        exists: false,
        size: 0,
        entries: [],
        pageStart: 0,
        end: 0,
        atStart: true,
      };
    }
    throw err;
  }
  try {
    const { size } = fs.fstatSync(fd);
    const until = Number.isInteger(end) ? Math.max(0, Math.min(end, size)) : size;
    const { entries, pageStart } = readEntriesBefore(fd, until, format);
    return {
      path: filePath,
      exists: true,
      size,
      entries,
      pageStart,
      end: until,
      atStart: pageStart === 0,
    };
  } finally {
    fs.closeSync(fd);
  }
}

// ── Search ─────────────────────────────────────────────────────────────────
// A batch of matches is capped like a page, so a term that matches thousands
// of entries comes back quickly and stays small for IPC.
const SEARCH_MAX_MATCHES = 200;
const SEARCH_MAX_QUERY = 1000;

function entryMatches(entry, needle, levels) {
  if (levels && entry.level !== null && !levels.has(entry.level)) return false;
  return (
    entry.text.toLowerCase().includes(needle) ||
    (entry.time !== null && entry.time.toLowerCase().includes(needle))
  );
}

// Searches the whole file, case-insensitively, newest match first — walking
// back from byte offset `end` (the end of the file by default) page by page,
// so entries are split exactly as readPage splits them and a match is always
// a whole entry. `levels`, when given, keeps only entries of those levels on
// the logs that have levels (the access log has none, so it never applies).
//
// Returns the page shape — { path, exists, size, query, entries, pageStart,
// end, atStart } — with `entries` the matches oldest-first. Once the batch is
// full the walk stops, and `pageStart` is the cursor: pass it back as `end`
// for the next, older batch. Every batch ends on an entry boundary, so
// batches never overlap. `atStart` means the file has no more matches.
function searchLog(filePath, kind, { query, end, levels } = {}) {
  const format = formatFor(kind);
  const needle = String(query ?? '')
    .trim()
    .toLowerCase();
  if (!needle) throw new Error('Search term is empty.');
  if (needle.length > SEARCH_MAX_QUERY) throw new Error('Search term is too long.');
  const levelSet = Array.isArray(levels) && format.levels ? new Set(levels) : null;

  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        path: filePath,
        exists: false,
        size: 0,
        query: needle,
        entries: [],
        pageStart: 0,
        end: 0,
        atStart: true,
      };
    }
    throw err;
  }
  try {
    const { size } = fs.fstatSync(fd);
    const until = Number.isInteger(end) ? Math.max(0, Math.min(end, size)) : size;
    const newestFirst = [];
    let bytes = 0;
    let cursor = until;
    scan: while (cursor > 0) {
      const page = readEntriesBefore(fd, cursor, format);
      for (let i = page.entries.length - 1; i >= 0; i--) {
        const entry = page.entries[i];
        cursor = entry.offset;
        if (!entryMatches(entry, needle, levelSet)) continue;
        newestFirst.push(entry);
        bytes += Buffer.byteLength(entry.text);
        if (newestFirst.length >= SEARCH_MAX_MATCHES || bytes >= PAGE_MAX_BYTES) {
          break scan;
        }
      }
      cursor = page.pageStart;
    }
    return {
      path: filePath,
      exists: true,
      size,
      query: needle,
      entries: newestFirst.reverse(),
      pageStart: cursor,
      end: until,
      atStart: cursor === 0,
    };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  LEVELS,
  PAGE_MAX_ENTRIES,
  PAGE_MAX_BYTES,
  ENTRY_MAX_BYTES,
  SEARCH_MAX_MATCHES,
  readPage,
  searchLog,
};
