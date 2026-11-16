'use strict';

// ── Per-Session terminal history on disk (#233) ──────────────────────────────
// Appends each Session's terminal output to `<userData>/wpxen-session-history/<sessionId>.log`
// with folder mode 0700 and file mode 0600 (readable only by the user's macOS
// account), capped at 5 MB (newest output kept).
//
// Electron-free: loads under plain Node and is copied into the staged Session
// Host directory so the host can write history directly.

const fs = require('fs');
const path = require('path');

// Naming law (CLAUDE.md "Legacy names"): everything written outside the app
// bundle carries the `wpxen` prefix via a named constant at the top of its
// module.
const WPXEN_SESSION_HISTORY_DIR = 'wpxen-session-history';
const MAX_HISTORY_BYTES = 5 * 1024 * 1024;

function historyDir(userDataDir) {
  if (!userDataDir) return null;
  return path.join(userDataDir, WPXEN_SESSION_HISTORY_DIR);
}

function safeSessionId(sessionId) {
  return path.basename(String(sessionId || '')).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function historyFilePath(dir, sessionId) {
  return path.join(dir, `${safeSessionId(sessionId)}.log`);
}

function ensureHistoryDir(dir) {
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
}

function trimToTailBytes(buf, maxBytes) {
  if (buf.length <= maxBytes) return buf;
  let start = buf.length - maxBytes;
  // Avoid splitting a multi-byte UTF-8 sequence at the boundary.
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
    start++;
  }
  return buf.subarray(start);
}

// Once a file passes the cap it is cut back to TRIM_TO of the cap, not to the
// cap itself: trimming to exactly the cap would rewrite the whole 5 MB file on
// every later output chunk. Cut points move forward to a line start where one
// is near, so replay rarely begins inside an escape sequence.
const TRIM_TO = 0.8;
const LINE_SEARCH_BYTES = 64 * 1024;

function trimToLineStart(buf) {
  const nl = buf.indexOf(0x0a);
  return nl !== -1 && nl < LINE_SEARCH_BYTES ? buf.subarray(nl + 1) : buf;
}

// Write via a temp file and rename, so a crash mid-trim never empties history.
function replaceFile(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {}
  fs.renameSync(tmp, file);
}

function appendHistory(dir, sessionId, chunk, maxBytes = MAX_HISTORY_BYTES) {
  if (!dir || !sessionId || !chunk) return;
  const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
  if (incoming.length === 0) return;

  ensureHistoryDir(dir);
  const file = historyFilePath(dir, sessionId);
  const keep = Math.max(1, Math.floor(maxBytes * TRIM_TO));

  if (incoming.length >= maxBytes) {
    replaceFile(file, trimToLineStart(trimToTailBytes(incoming, keep)));
    return;
  }

  fs.appendFileSync(file, incoming, { mode: 0o600 });

  const size = fs.statSync(file).size;
  if (size <= maxBytes) return;
  const fd = fs.openSync(file, 'r');
  let tail;
  try {
    const buf = Buffer.allocUnsafe(keep);
    fs.readSync(fd, buf, 0, keep, size - keep);
    tail = trimToLineStart(trimToTailBytes(buf, keep));
  } finally {
    fs.closeSync(fd);
  }
  replaceFile(file, tail);
}

function readHistory(dir, sessionId) {
  if (!dir || !sessionId) return '';
  const file = historyFilePath(dir, sessionId);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function clearHistory(dir, sessionId) {
  if (!dir || !sessionId) return;
  const file = historyFilePath(dir, sessionId);
  try {
    if (fs.existsSync(file)) {
      fs.writeFileSync(file, '', { mode: 0o600 });
    }
  } catch {}
}

function deleteHistory(dir, sessionId) {
  if (!dir || !sessionId) return;
  const file = historyFilePath(dir, sessionId);
  try {
    fs.unlinkSync(file);
  } catch {}
}

function pruneOrphanedHistory(dir, validSessionIds) {
  if (!dir || !fs.existsSync(dir)) return;
  const valid = new Set(
    [...(validSessionIds || [])].map((id) => `${safeSessionId(id)}.log`)
  );
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
    if (!valid.has(entry.name)) {
      try {
        fs.unlinkSync(path.join(dir, entry.name));
      } catch {}
    }
  }
}

module.exports = {
  WPXEN_SESSION_HISTORY_DIR,
  MAX_HISTORY_BYTES,
  historyDir,
  historyFilePath,
  appendHistory,
  readHistory,
  clearHistory,
  deleteHistory,
  pruneOrphanedHistory,
};
