const fs = require('fs');
const path = require('path');
const claudeDecoder = require('./agentChatClaude.cjs');

let deps = {
  statSync: fs.statSync,
  openSync: fs.openSync,
  readSync: fs.readSync,
  closeSync: fs.closeSync,
  readdirSync: fs.readdirSync,
  readFileSync: fs.readFileSync,
  setInterval,
  clearInterval,
  now: () => Date.now(),
};

function __setDeps(newDeps) {
  deps = { ...deps, ...newDeps };
}

// ── Constants ──────────────────────────────────────────────────────────────
const POLL_INTERVAL = 400;
const PAGE_CHUNK = 64 * 1024; // 64 KB read chunks
const MAX_PAGE_ROWS = 200;
const MAX_PAGE_BYTES = 2 * 1024 * 1024; // 2 MB
// A single transcript line larger than this is never parsed: it becomes a
// placeholder row (after Orca's transcript-tail-reader.ts:183-195, which
// skips records over its cap). Above the page budget on purpose — a pasted
// screenshot's record is base64 up to ~7 MB, and its row is only a ref.
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const TOO_LARGE_TEXT = 'Transcript entry too large to show';
// A tool result's head: what crosses IPC until the reader asks for the rest
// (Orca's structured-path cap, agent-session-item-wire-form.ts:21).
const TRUNCATE_THRESHOLD = 16 * 1024;
const FETCH_FULL_CAP = 1 * 1024 * 1024; // 1 MB cap for fetch-full

// ── Watches ────────────────────────────────────────────────────────────────
// sessionId -> watch
const watches = new Map();

// Read a byte range from an fd into a Buffer.
function readRange(fd, start, length) {
  const buf = Buffer.alloc(length);
  const n = deps.readSync(fd, buf, 0, length, start);
  return buf.slice(0, n);
}

// Split a buffer read from `base` into lines, each with the byte offset it
// starts at. Returns { lines: { offset, text }[], partial: Buffer }, where
// `partial` is the trailing bytes after the last newline.
function splitLines(buf, base = 0) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      lines.push({ offset: base + start, text: buf.slice(start, i).toString('utf8') });
      start = i + 1;
    }
  }
  return { lines, partial: buf.slice(start) };
}

// A line's id when its record carries none (Codex rollouts write no
// payload.id): its byte offset, which every read of the file agrees on — the
// first page, Load older and the live tail alike (after Orca's
// transcript-fallback-id.ts). The basename keeps the user's paths off IPC;
// one watch never reads two files of the same name into one row list.
const FALLBACK_ID_WIDTH = 16;
function transcriptFallbackId(file, offset) {
  return `${path.basename(file)}:${String(offset).padStart(FALLBACK_ID_WIDTH, '0')}`;
}

// Decode lines into rows, truncating results. Each decoder gets the line,
// its state, and { fallbackId } for a record with no id of its own. A line
// over MAX_LINE_BYTES (`oversized` from a page read, or a long one the live
// tail just read) is a placeholder instead.
function decodeLines(lines, state, decodeLine, file) {
  const rows = [];
  for (const { offset, text, oversized } of lines) {
    const fallbackId = transcriptFallbackId(file, offset);
    if (oversized || tooLong(text)) {
      rows.push({
        id: fallbackId,
        role: 'status',
        tooLarge: true,
        content: TOO_LARGE_TEXT,
      });
      continue;
    }
    if (!text.trim()) continue;
    const row = decodeLine(text, state, { fallbackId });
    if (row) rows.push(...[row].flat().map(truncateRow));
  }
  return rows;
}

// Characters never outnumber UTF-8 bytes, so most lines skip the count.
function tooLong(text) {
  return text.length > MAX_LINE_BYTES / 4 && Buffer.byteLength(text) > MAX_LINE_BYTES;
}

// A result over the cap, cut to its head and marked so the chat offers
// "Show full output". `fullBytes` says how much there is.
function truncateResult(result) {
  if (
    !result ||
    typeof result.content !== 'string' ||
    result.content.length <= TRUNCATE_THRESHOLD
  ) {
    return result;
  }
  return {
    ...result,
    content: result.content.slice(0, TRUNCATE_THRESHOLD),
    truncated: true,
    fullBytes: Buffer.byteLength(result.content),
  };
}

// Cap every tool result a row carries before it crosses IPC: a paired call's
// `result`, and an orphan's tool_result blocks. Decoders keep the result on
// the call block too (`tool_use.result`, Claude's pairing state); the row
// sends it once, on `result`. The call block is always copied: it is the
// decoder's own object, and a result decoded later in the same page would
// otherwise land on a row already emitted. Never mutates decoder state.
function truncateRow(row) {
  if (!row || typeof row !== 'object') return row;
  let next = row;
  const copy = () => {
    if (next === row) next = { ...row };
  };
  if (row.tool_use && typeof row.tool_use === 'object') {
    copy();
    const toolUse = { ...row.tool_use };
    delete toolUse.result;
    next.tool_use = toolUse;
  }
  if (row.result) {
    const capped = truncateResult(row.result);
    if (capped !== row.result) {
      copy();
      next.result = capped;
    }
  }
  if (Array.isArray(row.blocks)) {
    let changed = false;
    const blocks = row.blocks.map((b) => {
      if (b?.type !== 'tool_result') return b;
      const capped = truncateResult(b);
      if (capped !== b) changed = true;
      return capped;
    });
    if (changed) {
      copy();
      next.blocks = blocks;
    }
  }
  return next;
}

// ── Page reads ─────────────────────────────────────────────────────────────
// Read backwards from `end` a line at a time, collecting up to MAX_PAGE_ROWS
// lines or MAX_PAGE_BYTES read, whichever comes first. The budget is checked
// only between lines, so a page always ends on a whole line and Load older
// always moves: a line bigger than the budget used to leave `pageStart`
// where it was, and every click re-read the same bytes. A line over
// MAX_LINE_BYTES is scanned past without being kept (`oversized`).
// Returns the page's lines, oldest first with their offsets, and
// `pageStart`, where the next older page ends.
function readPageLines(fd, end) {
  let cursor = end;
  let bytesRead = 0;
  const newestFirst = [];
  // The line being assembled, newest chunk first.
  let parts = [];
  let partBytes = 0;
  let oversized = false;
  let pageStart = end;

  const retain = (part) => {
    if (oversized || part.length === 0) return;
    partBytes += part.length;
    if (partBytes > MAX_LINE_BYTES) {
      parts = [];
      oversized = true;
      return;
    }
    parts.push(part);
  };
  // The line starting at `offset` is complete.
  const finish = (offset) => {
    if (oversized) newestFirst.push({ offset, oversized: true, text: '' });
    else {
      const bytes = parts.length === 1 ? parts[0] : Buffer.concat(parts.reverse());
      newestFirst.push({ offset, text: bytes.toString('utf8') });
    }
    parts = [];
    partBytes = 0;
    oversized = false;
    pageStart = offset;
  };
  const full = () => newestFirst.length >= MAX_PAGE_ROWS || bytesRead >= MAX_PAGE_BYTES;

  // `end` sits just past a newline (or is 0), so the newline before it
  // closes nothing: lines start right after each newline found below it.
  scan: while (cursor > 0) {
    const chunkStart = Math.max(0, cursor - PAGE_CHUNK);
    const buf = readRange(fd, chunkStart, cursor - chunkStart);
    if (buf.length === 0) break;
    bytesRead += buf.length;
    let segmentEnd = buf.length;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i] !== 0x0a) continue;
      const lineStart = chunkStart + i + 1;
      retain(buf.subarray(i + 1, segmentEnd));
      segmentEnd = i;
      if (lineStart < end) {
        finish(lineStart);
        if (full()) break scan;
      }
    }
    retain(buf.subarray(0, segmentEnd));
    cursor = chunkStart;
  }
  // The file's first line has no newline before it.
  if (cursor === 0 && pageStart > 0 && (parts.length > 0 || oversized)) finish(0);

  return { lines: newestFirst.reverse(), pageStart };
}

// ── Facts from before the first page ───────────────────────────────────────
// A Session's facts (background tasks, the model's context window) can rest
// on records far above the newest page: a background task started an hour
// ago, the `model` attachment written once at session start. A decoder that
// names `markers` — strings only such records contain — gets each matching
// line of the rest of the file through `noteFacts(line, state)`, oldest
// first, before the newest page is decoded with the same state. Lines are
// found with Buffer.indexOf, so a 100 MB transcript is scanned, not parsed.
const FACT_SCAN_CHUNK = 1024 * 1024;

function scanFacts(fd, end, { markers, noteFacts }, state) {
  if (!end || !Array.isArray(markers) || !markers.length || !noteFacts) return;
  const needles = markers.map((m) => Buffer.from(m));
  let pos = 0;
  let carry = Buffer.alloc(0);
  let skipping = false; // inside a line too long to keep
  while (pos < end) {
    let buf = readRange(fd, pos, Math.min(FACT_SCAN_CHUNK, end - pos));
    if (buf.length === 0) break;
    pos += buf.length;
    if (skipping) {
      const nl = buf.indexOf(0x0a);
      if (nl === -1) continue;
      skipping = false;
      buf = buf.subarray(nl + 1);
    }
    const combined = carry.length ? Buffer.concat([carry, buf]) : buf;
    const lastNl = combined.lastIndexOf(0x0a);
    carry = lastNl === -1 ? combined : combined.subarray(lastNl + 1);
    if (carry.length > MAX_LINE_BYTES) {
      carry = Buffer.alloc(0);
      skipping = true;
    }
    if (lastNl === -1) continue;
    const whole = combined.subarray(0, lastNl + 1);
    const hits = new Map(); // line start -> line end
    for (const needle of needles) {
      for (let i = whole.indexOf(needle); i !== -1;) {
        const start = whole.lastIndexOf(0x0a, i) + 1;
        const stop = whole.indexOf(0x0a, i);
        hits.set(start, stop);
        i = whole.indexOf(needle, stop + 1);
      }
    }
    for (const start of [...hits.keys()].sort((a, b) => a - b)) {
      try {
        noteFacts(whole.toString('utf8', start, hits.get(start)), state);
      } catch {
        // a fact line that doesn't parse is not a fact
      }
    }
  }
}

// The newest page. Returns { rows, pageStart, state }. `factScan`
// ({ markers, noteFacts }) seeds the state from the lines above the page.
function tailRead(fd, fileSize, decodeLine, file, factScan = null) {
  if (fileSize === 0) return { rows: [], pageStart: 0, state: {} };
  const { lines, pageStart } = readPageLines(fd, fileSize);
  const state = {};
  if (factScan) scanFacts(fd, pageStart, factScan, state);
  const rows = decodeLines(lines, state, decodeLine, file);
  return { rows, pageStart, state };
}

// What the chat shows beside the rows, compared to push it only on change.
function factsKey(state) {
  try {
    return JSON.stringify(state?.facts ?? null);
  } catch {
    return null;
  }
}

// ── Older page ─────────────────────────────────────────────────────────────
// `results` holds the orphan tool results newer pages already decoded, so a
// call paged in here picks its result up.
function loadOlderPage(fd, pageStart, decodeLine, file, results = {}) {
  if (pageStart <= 0) return { rows: [], pageStart: 0, atStart: true };
  const { lines, pageStart: newPageStart } = readPageLines(fd, pageStart);
  const rows = decodeLines(lines, { results }, decodeLine, file);
  return { rows, pageStart: newPageStart, atStart: newPageStart <= 0 };
}

// ── Fetch full tool result ─────────────────────────────────────────────────
// Each decoder knows where its results live: `findToolResult(record, id)`
// returns a result's full text or null, and `toolResultNeedle(id)` a string
// every line holding it contains, so the scan parses only those lines. The
// last match wins: a re-reported step is the complete one.
function fetchFull(fd, fileSize, toolUseId, decoder = claudeDecoder) {
  if (typeof toolUseId !== 'string' || !toolUseId) return null;
  const find = decoder.findToolResult || claudeDecoder.findToolResult;
  const needle = decoder.toolResultNeedle
    ? decoder.toolResultNeedle(toolUseId)
    : toolUseId;
  let cursor = 0;
  let partial = Buffer.alloc(0);
  let found = null;

  while (cursor < fileSize) {
    const chunkLen = Math.min(PAGE_CHUNK, fileSize - cursor);
    const buf = readRange(fd, cursor, chunkLen);
    if (buf.length === 0) break;
    cursor += buf.length;

    const combined = Buffer.concat([partial, buf]);
    const { lines, partial: remainder } = splitLines(combined);
    partial = remainder;

    for (const { text: line } of lines) {
      if (needle && !line.includes(needle)) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const content = find(record, toolUseId);
      if (typeof content === 'string') found = content;
    }
  }
  if (found === null) return null;
  return found.length > FETCH_FULL_CAP ? found.slice(0, FETCH_FULL_CAP) : found;
}

// ── Stale transcript detection ─────────────────────────────────────────────
// /clear starts a new transcript file that opens with the /clear command
// record, within its first few KB.
const CLEAR_MARKER = '<command-name>/clear</command-name>';
const CLEAR_HEAD_BYTES = 16 * 1024;

function opensWithClear(fullPath) {
  let fd = null;
  try {
    fd = deps.openSync(fullPath, 'r');
    return readRange(fd, 0, CLEAR_HEAD_BYTES).toString('utf8').includes(CLEAR_MARKER);
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        deps.closeSync(fd);
      } catch {}
    }
  }
}

// The Session moved on to a new conversation file (/clear). The project
// folder is shared by every Claude session in that cwd, so a newer file only
// counts if /clear opened it and no other live Session has pinned it.
function checkStaleTranscript(watch) {
  if (!watch.transcriptDir || !watch.transcriptId) return false;
  try {
    const files = deps.readdirSync(watch.transcriptDir);
    for (const f of files) {
      if (!f.endsWith('.jsonl') || watch.notStale.has(f)) continue;
      const uuid = f.slice(0, -'.jsonl'.length);
      if (uuid === watch.transcriptId) continue;
      const fullPath = path.join(watch.transcriptDir, f);
      try {
        if (deps.statSync(fullPath).mtimeMs <= watch.startedAtMs) continue;
      } catch {
        continue;
      }
      // A file's head never changes, so a miss is final.
      if (watch.isPinnedElsewhere(uuid) || !opensWithClear(fullPath)) {
        watch.notStale.add(f);
        continue;
      }
      return true;
    }
  } catch {
    // ignore readdir errors
  }
  return false;
}

// Bytes up to and including the last newline: a trailing partial line is
// held back until Claude finishes writing it.
function completeLength(fd, size) {
  let cursor = size;
  while (cursor > 0) {
    const start = Math.max(0, cursor - PAGE_CHUNK);
    const buf = readRange(fd, start, cursor - start);
    const nl = buf.lastIndexOf(0x0a);
    if (nl !== -1) return start + nl + 1;
    cursor = start;
  }
  return 0;
}

function augmentToolRows(watch, rows) {
  for (const row of rows) {
    if (row.role === 'tool' && row.tool_use) {
      for (const sub of watch.subagents.values()) {
        if (sub.toolUseId === row.tool_use.id) labelSubagentRow(watch, sub, row);
      }
    }
  }
}

// ── Subagents ──────────────────────────────────────────────────────────────
// Claude keeps a Session's subagents beside its transcript:
// <project>/<uuid>/subagents/agent-<id>.jsonl, with a .meta.json naming the
// type, description and the parent's tool_use id.
function subagentDir(watch) {
  return path.join(watch.transcriptDir, watch.transcriptId, 'subagents');
}

function subagentPath(watch, sub) {
  return path.join(subagentDir(watch), `agent-${sub.agentId}.jsonl`);
}

// A subagent's state, after Orca's transcript-only fallback
// (session-scanner-claude-subagents.ts:170-226). A synchronous Agent call
// runs until its result lands. A background one returns `async_launched`
// at once and settles only when a <task-notification> reports its agentId;
// with no final report it counts as running only while its transcript was
// written in the last five minutes, else its state is unknown (null).
const SUBAGENT_RUNNING_RECENCY_MS = 5 * 60_000;
const TERMINAL_SUBAGENT_STATUSES = {
  completed: 'done',
  failed: 'failed',
  killed: 'stopped',
  stopped: 'stopped',
};

function subagentStatus(watch, sub, parentRow) {
  if (!parentRow) return null;
  const result = parentRow.result;
  if (!result) return 'running';
  if (!result.meta?.asyncLaunched) return result.is_error ? 'failed' : 'done';
  const reported = watch.state.facts?.agents?.[sub.agentId];
  if (TERMINAL_SUBAGENT_STATUSES[reported]) return TERMINAL_SUBAGENT_STATUSES[reported];
  try {
    const { mtimeMs } = deps.statSync(subagentPath(watch, sub));
    return deps.now() - mtimeMs <= SUBAGENT_RUNNING_RECENCY_MS ? 'running' : null;
  } catch {
    return null;
  }
}

function labelSubagentRow(watch, sub, row) {
  row.subagent = {
    agentId: sub.agentId,
    type: sub.type,
    description: sub.description,
    status: subagentStatus(watch, sub, row),
  };
  row.subagentCount = sub.state?.toolUseCount || 0;
}

// The newest copy of a tool row: a call is re-emitted once its result lands.
function latestToolRow(watch, toolUseId) {
  for (let i = watch.currentRows.length - 1; i >= 0; i--) {
    const r = watch.currentRows[i];
    if (r.role === 'tool' && r.tool_use?.id === toolUseId) return r;
  }
  return null;
}

function discoverSubagents(watch) {
  let files;
  try {
    files = deps.readdirSync(subagentDir(watch));
  } catch {
    return; // no subagents yet
  }
  for (const f of files) {
    const match = /^agent-(.+)\.meta\.json$/.exec(f);
    if (!match || watch.subagents.has(match[1])) continue;
    const agentId = match[1];
    let meta;
    try {
      meta = JSON.parse(deps.readFileSync(path.join(subagentDir(watch), f), 'utf8'));
    } catch {
      continue; // written but not finished, or unreadable: retry next poll
    }
    watch.subagents.set(agentId, {
      agentId,
      type: meta.agentType,
      description: meta.description,
      toolUseId: meta.toolUseId,
      expanded: false,
      fd: null,
      tailOffset: 0,
      pageStart: 0,
      state: {},
      currentRows: [],
    });
    const parentRow = latestToolRow(watch, meta.toolUseId);
    if (parentRow) {
      labelSubagentRow(watch, watch.subagents.get(agentId), parentRow);
      watch.onRows([parentRow]);
    }
  }
}

function closeSubagent(sub) {
  if (sub.fd === null) return;
  try {
    deps.closeSync(sub.fd);
  } catch {}
  sub.fd = null;
}

function pollSubagent(watch, sub) {
  const parentRow = latestToolRow(watch, sub.toolUseId);
  const status = subagentStatus(watch, sub, parentRow);
  // A background subagent settles from a notification the parent decodes as
  // no row at all: push the parent row whenever its state moves.
  if (parentRow?.subagent && parentRow.subagent.status !== status) {
    parentRow.subagent = { ...parentRow.subagent, status };
    watch.onRows([parentRow]);
  }
  const running = status === 'running';
  if (!running && !sub.expanded) return closeSubagent(sub);

  const nested = (rows) => rows.map((r) => ({ ...r, parentId: sub.toolUseId }));
  const reportCount = () => {
    if (parentRow && sub.state.toolUseCount !== undefined) {
      parentRow.subagentCount = sub.state.toolUseCount;
      watch.onRows([parentRow]);
    }
  };

  const subPath = subagentPath(watch, sub);
  try {
    if (sub.fd === null) {
      sub.fd = deps.openSync(subPath, 'r');
      const complete = completeLength(sub.fd, deps.statSync(subPath).size);
      const { rows, pageStart, state } = tailRead(
        sub.fd,
        complete,
        watch.decodeLine,
        subPath
      );
      sub.currentRows = rows;
      sub.pageStart = pageStart;
      sub.state = state;
      sub.tailOffset = complete;
      if (rows.length > 0) watch.onRows(nested(rows));
      reportCount();
      return;
    }

    const size = deps.statSync(subPath).size;
    if (size <= sub.tailOffset) return;
    const buf = readRange(sub.fd, sub.tailOffset, size - sub.tailOffset);
    const { lines, partial } = splitLines(buf, sub.tailOffset);
    sub.tailOffset += buf.length - partial.length;
    const newRows = decodeLines(lines, sub.state, watch.decodeLine, subPath);
    if (newRows.length > 0) {
      sub.currentRows.push(...newRows);
      watch.onRows(nested(newRows));
      reportCount();
    }
  } catch {
    // Missing or unreadable subagent file: the parent stays a plain tool row.
  }
}

// ── Open / Close ───────────────────────────────────────────────────────────
function openChat(sessionId, viewerId, opts) {
  const {
    transcriptPath,
    onRows,
    decodeLine,
    // { findToolResult, toolResultNeedle } for "Show full output"; Claude's
    // when absent.
    findToolResult,
    toolResultNeedle,
    // { markers, noteFacts }: see scanFacts.
    factScan = null,
    onNotice,
    transcriptId,
    startedAt,
    isPinnedElsewhere = () => false,
    relocate,
  } = opts;

  let watch = watches.get(sessionId);
  if (watch) {
    watch.viewers.add(viewerId);
    // Replay current rows to the new viewer
    if (watch.currentRows.length > 0) {
      onRows(watch.currentRows, watch.state, { atStart: watch.pageStart <= 0 });
    }
    return;
  }

  const fd = deps.openSync(transcriptPath, 'r');
  const stat = deps.statSync(transcriptPath);

  watch = {
    viewers: new Set([viewerId]),
    path: transcriptPath,
    relocate: relocate || null,
    transcriptDir: path.dirname(transcriptPath),
    transcriptId: transcriptId || path.basename(transcriptPath, '.jsonl'),
    startedAtMs: startedAt ? new Date(startedAt).getTime() : Date.now(),
    interval: null,
    fd,
    fileSize: stat.size,
    decodeLine,
    resultDecoder: findToolResult ? { findToolResult, toolResultNeedle } : claudeDecoder,
    onRows,
    onNotice,
    currentRows: [],
    pageStart: 0,
    state: {},
    staleNotified: false,
    isPinnedElsewhere,
    notStale: new Set(), // folder files ruled out as this Session's successor
    subagents: new Map(),
    tailOffset: 0, // end of the last complete line read
  };
  watches.set(sessionId, watch);

  // Initial tail read. A read that fails leaves no half-open watch behind
  // (one with a viewer and no poll would never recover): undo and rethrow.
  let complete;
  let rows;
  let pageStart;
  let state;
  try {
    complete = completeLength(fd, stat.size);
    ({ rows, pageStart, state } = tailRead(
      fd,
      complete,
      decodeLine,
      transcriptPath,
      factScan
    ));
  } catch (err) {
    watches.delete(sessionId);
    try {
      deps.closeSync(fd);
    } catch {}
    throw err;
  }
  watch.currentRows = rows;
  watch.pageStart = pageStart;
  watch.state = state;
  watch.tailOffset = complete;
  watch.factsKey = factsKey(state);

  // `atStart`: the first page already reaches the top of the file, so the
  // chat offers no "Load older".
  if (rows.length > 0) {
    onRows(rows, watch.state, { atStart: pageStart <= 0 });
  }

  // Poll for new data
  const poll = () => {
    try {
      // 1. Discover subagents
      discoverSubagents(watch);

      // 2. Poll parent
      const newStat = deps.statSync(watch.path);
      const newSize = newStat.size;

      if (newSize < watch.tailOffset) {
        watch.tailOffset = 0;
        watch.state = {};
        watch.currentRows = [];
        watch.pageStart = 0;
        watch.staleNotified = false;
        onRows([{ reset: true }], watch.state);
        // maybe close subagents too? Not needed, handled.
      } else if (newSize > watch.tailOffset) {
        const length = newSize - watch.tailOffset;
        const buf = readRange(watch.fd, watch.tailOffset, length);
        watch.fileSize = newSize;

        // Only complete lines advance the offset; a partial one is re-read
        // whole on the next poll.
        const { lines, partial } = splitLines(buf, watch.tailOffset);
        watch.tailOffset += buf.length - partial.length;
        const newRows = decodeLines(lines, watch.state, watch.decodeLine, watch.path);

        // A record can move the facts and render nothing — a
        // <task-notification>, a task_status attachment — so the facts
        // are pushed whenever they change, rows or not.
        const key = factsKey(watch.state);
        const factsChanged = key !== watch.factsKey;
        watch.factsKey = key;
        if (newRows.length > 0) {
          augmentToolRows(watch, newRows);
          watch.currentRows.push(...newRows);
          onRows(newRows, watch.state);
        } else if (factsChanged) {
          onRows([], watch.state);
        }
      }

      // 3. Check for stale transcript
      if (!watch.staleNotified && checkStaleTranscript(watch)) {
        watch.staleNotified = true;
        onRows([{ notice: true, kind: 'transcript-changed' }], watch.state);
      }

      // 3b. Re-locate transcripts that move (Antigravity maps each folder to
      // a conversation id that changes when a new conversation starts).
      if (!watch.staleNotified && watch.relocate) {
        try {
          const current = watch.relocate();
          if (current && current !== watch.path) {
            watch.staleNotified = true;
            onRows([{ notice: true, kind: 'transcript-changed' }], watch.state);
          }
        } catch {
          // a failed re-locate is not a transcript change
        }
      }

      // 4. Poll subagents: only while running or expanded, so a Session
      // with many finished subagents stays cheap.
      for (const sub of watch.subagents.values()) pollSubagent(watch, sub);
    } catch {
      // Missing file or read error
    }
  };

  watch.interval = deps.setInterval(poll, POLL_INTERVAL);
}

function loadOlder(sessionId) {
  const watch = watches.get(sessionId);
  if (!watch) return { rows: [], atStart: true };

  watch.state.results = watch.state.results || {};
  const { rows, pageStart, atStart } = loadOlderPage(
    watch.fd,
    watch.pageStart,
    watch.decodeLine,
    watch.path,
    watch.state.results
  );
  watch.pageStart = pageStart;

  if (rows.length > 0) {
    // Subagents are discovered from the folder, not the page: an Agent call
    // paged in now may already have one.
    augmentToolRows(watch, rows);
    watch.currentRows.unshift(...rows);
  }

  return { rows, atStart };
}

function chatFetchFull(sessionId, toolUseId) {
  const watch = watches.get(sessionId);
  if (!watch) return null;
  return fetchFull(watch.fd, watch.fileSize, toolUseId, watch.resultDecoder);
}

function closeChat(sessionId, viewerId) {
  const watch = watches.get(sessionId);
  if (!watch) return;
  watch.viewers.delete(viewerId);
  if (watch.viewers.size === 0) {
    if (watch.interval) deps.clearInterval(watch.interval);
    for (const sub of watch.subagents.values()) closeSubagent(sub);
    if (watch.fd !== null) {
      try {
        deps.closeSync(watch.fd);
      } catch {}
    }
    watches.delete(sessionId);
  }
}

function closeAllChats() {
  for (const watch of watches.values()) {
    if (watch.interval) deps.clearInterval(watch.interval);
    for (const sub of watch.subagents.values()) closeSubagent(sub);
    if (watch.fd !== null) {
      try {
        deps.closeSync(watch.fd);
      } catch {}
    }
  }
  watches.clear();
}

// Subagents are addressed by their parent's tool_use id — what the renderer
// holds.
function findSubagent(watch, toolUseId) {
  for (const sub of watch.subagents.values()) {
    if (sub.toolUseId === toolUseId) return sub;
  }
  return null;
}

function chatExpandSubagent(sessionId, toolUseId, expanded) {
  const watch = watches.get(sessionId);
  const sub = watch && findSubagent(watch, toolUseId);
  if (sub) sub.expanded = !!expanded;
}

function chatLoadOlderSubagent(sessionId, toolUseId) {
  const watch = watches.get(sessionId);
  if (!watch) return { rows: [], atStart: true };
  const sub = findSubagent(watch, toolUseId);
  if (!sub || sub.fd === null) return { rows: [], atStart: true };

  const { rows, pageStart, atStart } = loadOlderPage(
    sub.fd,
    sub.pageStart,
    watch.decodeLine,
    subagentPath(watch, sub)
  );
  sub.pageStart = pageStart;

  if (rows.length > 0) {
    sub.currentRows.unshift(...rows);
  }

  const mappedRows = rows.map((r) => ({ ...r, parentId: sub.toolUseId }));
  return { rows: mappedRows, atStart };
}

// Images are served only from this Session's own transcripts, located by a
// record uuid and a block position — never by a path the renderer supplies.
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
// Raster types only: an SVG data URL can carry script.
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function validImageRef(ref) {
  return (
    !!ref &&
    typeof ref.uuid === 'string' &&
    /^[\w-]{1,100}$/.test(ref.uuid) &&
    Array.isArray(ref.path) &&
    ref.path.length >= 1 &&
    ref.path.length <= 2 &&
    ref.path.every((i) => Number.isInteger(i) && i >= 0)
  );
}

async function findRecord(file, uuid) {
  const readline = require('readline');
  const needle = `"uuid":"${uuid}"`;
  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      if (!line.includes(needle)) continue;
      try {
        const record = JSON.parse(line);
        if (record.uuid === uuid) return record;
      } catch {}
    }
  } finally {
    rl.close();
  }
  return null;
}

async function chatImage(sessionId, ref) {
  const watch = watches.get(sessionId);
  if (!watch || !validImageRef(ref)) return null;
  const files = [
    watch.path,
    ...[...watch.subagents.values()].map((sub) => subagentPath(watch, sub)),
  ];
  for (const file of files) {
    let record;
    try {
      record = await findRecord(file, ref.uuid);
    } catch {
      continue;
    }
    if (!record) continue;
    let block = record.message?.content?.[ref.path[0]];
    if (ref.path.length === 2) block = block?.content?.[ref.path[1]];
    const source = block?.type === 'image' ? block.source : null;
    if (source?.type !== 'base64' || typeof source.data !== 'string') return null;
    if (!IMAGE_TYPES.has(source.media_type)) return null;
    if (Math.floor((source.data.length * 3) / 4) > IMAGE_MAX_BYTES)
      return { tooLarge: true };
    return `data:${source.media_type};base64,${source.data}`;
  }
  return null;
}

module.exports = {
  __setDeps,
  openChat,
  closeChat,
  closeAllChats,
  loadOlder,
  chatFetchFull,
  chatExpandSubagent,
  chatLoadOlderSubagent,
  chatImage,
  IMAGE_MAX_BYTES,
  transcriptFallbackId,
  // Exposed for testing
  MAX_PAGE_ROWS,
  MAX_PAGE_BYTES,
  MAX_LINE_BYTES,
  TRUNCATE_THRESHOLD,
  FETCH_FULL_CAP,
};
