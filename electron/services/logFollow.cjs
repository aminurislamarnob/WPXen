'use strict';

// Live follow for the Site Logs viewer: while a log view is open, polls its
// file and hands new entries to `onEvent`. Pure apart from the timer and the
// file — a path and a log kind in, logReader entries out — so it's tested
// against temp files, and the caller (ipc.cjs) decides where events go.
//
// Each poll re-reads from the start of the newest entry the view holds, not
// from the end of the file, so continuation lines written after their header
// (a stack trace flushed a moment after its fatal) land in that same entry:
// the renderer replaces entries by `offset` and appends the rest.

const fs = require('fs');
const logReader = require('./logReader.cjs');

let deps = {
  setInterval,
  clearInterval,
};

function __setDeps(newDeps) {
  deps = { ...deps, ...newDeps };
}

// Comfortably inside the "a new fatal shows within a second" budget; the
// same cadence as the Agents chat tail (agentChat.cjs).
const POLL_INTERVAL = 400;

// How much new text one poll parses in place. More than this arrived since
// the last poll (an import dumping notices, a load test on the access log)
// and the view restarts at the newest page instead — bounded like any page,
// with Load older reaching the rest.
const FOLLOW_MAX_BYTES = logReader.PAGE_MAX_BYTES;
// The file's first bytes, kept to tell "the same log, grown" from "cleared,
// then written past its old size between two polls": the same inode and a
// bigger size either way, but a log's first line (a timestamp) won't repeat.
const HEAD_BYTES = 64;

// id -> watch
const watches = new Map();

// The file's stat, or null when there is none.
function statOf(filePath) {
  try {
    return fs.statSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function readRange(filePath, from, to) {
  const buf = Buffer.alloc(Math.max(0, to - from));
  const fd = fs.openSync(filePath, 'r');
  try {
    // Zero-filled to full length, so a file that shrank mid-read reads as
    // "different" rather than throwing.
    fs.readSync(fd, buf, 0, buf.length, from);
  } finally {
    fs.closeSync(fd);
  }
  return buf;
}

// Which file the path names now: inode, device and first bytes, or null
// when it's missing.
function identityOf(filePath, stat) {
  if (!stat) return null;
  return {
    ino: stat.ino,
    dev: stat.dev,
    head: readRange(filePath, 0, Math.min(stat.size, HEAD_BYTES)),
  };
}

// Is `stat` still the file `watch` was reading? A rename-and-recreate
// (rotation) changes the inode; Clear truncates in place, which shows as a
// smaller size, or — written past again before the next poll — as different
// first bytes.
function sameFile(watch, stat) {
  const known = watch.identity;
  if (!known || !stat) return known === stat;
  if (stat.ino !== known.ino || stat.dev !== known.dev) return false;
  if (stat.size < watch.tail) return false;
  const head = readRange(watch.path, 0, known.head.length);
  return head.equals(known.head);
}

// The end of the last whole line in [from, to), or -1 — a line still being
// written is left for a later poll, so it's never parsed half-done.
function lastLineEnd(filePath, from, to) {
  const nl = readRange(filePath, from, to).lastIndexOf(0x0a);
  return nl === -1 ? -1 : from + nl + 1;
}

// Starts the view over at the newest page of whatever the path names now.
function restart(watch, stat) {
  const page = logReader.readPage(watch.path, watch.kind);
  watch.identity = identityOf(watch.path, stat);
  watch.tail = page.end;
  watch.from = page.entries.length
    ? page.entries[page.entries.length - 1].offset
    : page.end;
  watch.onEvent({ reset: true, page });
}

function poll(watch) {
  const stat = statOf(watch.path);
  if (!sameFile(watch, stat)) return restart(watch, stat);
  if (!stat || stat.size <= watch.tail) return;
  if (stat.size - watch.tail > FOLLOW_MAX_BYTES) return restart(watch, stat);
  const end = lastLineEnd(watch.path, watch.tail, stat.size);
  if (end === -1) return;
  const page = logReader.readPage(watch.path, watch.kind, { end });
  // The page has to reach back to the view's newest entry, or entries
  // between the two would be skipped.
  if (page.pageStart > watch.from) return restart(watch, stat);
  const entries = page.entries.filter((e) => e.offset >= watch.from);
  watch.tail = page.end;
  if (entries.length) watch.from = entries[entries.length - 1].offset;
  // A head captured while the file was shorter than HEAD_BYTES grows with it.
  if (watch.identity.head.length < HEAD_BYTES)
    watch.identity = identityOf(watch.path, stat);
  watch.onEvent({ entries, size: page.size });
}

// Starts following `filePath` under `id` (replacing any watch already under
// it). `from` is the offset of the newest entry the view shows (or the page
// end when it shows none) and `end` the page's end, so nothing written
// between the page read and this call is missed. `onEvent` gets either
// `{ entries, size }` — new entries, plus the newest one shown, re-read in
// case it grew — or `{ reset: true, page }`, a fresh newest page that
// replaces the view (Clear, rotation, a burst, a file created or deleted).
function follow(id, filePath, kind, { from = 0, end = 0 } = {}, onEvent) {
  unfollow(id);
  // Offsets arrive over IPC; anything but a byte offset means "from the
  // start", which costs a reset at worst.
  const offset = (n) => (Number.isInteger(n) && n >= 0 ? n : 0);
  const watch = {
    path: filePath,
    kind,
    from: offset(from),
    tail: offset(end),
    onEvent,
    interval: null,
  };
  const stat = statOf(filePath);
  // Cleared between the page read and now? The first poll's size check
  // (smaller than `end`) catches it.
  watch.identity = identityOf(filePath, stat);
  watch.interval = deps.setInterval(() => {
    try {
      poll(watch);
    } catch {
      // A read that fails (permissions, a file mid-rotation) is retried on
      // the next poll rather than ending the follow.
    }
  }, POLL_INTERVAL);
  watches.set(id, watch);
}

function unfollow(id) {
  const watch = watches.get(id);
  if (!watch) return;
  deps.clearInterval(watch.interval);
  watches.delete(id);
}

// Every watch — the window closed, navigated away, or the app is quitting.
function closeAll() {
  for (const id of [...watches.keys()]) unfollow(id);
}

module.exports = {
  POLL_INTERVAL,
  follow,
  unfollow,
  closeAll,
  activeCount: () => watches.size,
  __setDeps,
};
