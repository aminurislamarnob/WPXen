const fs = require('fs');
const path = require('path');
const { toolResultText } = require('./agentChatClaude.cjs');

let deps = {
  statSync: fs.statSync,
  openSync: fs.openSync,
  readSync: fs.readSync,
  closeSync: fs.closeSync,
  readdirSync: fs.readdirSync,
  readFileSync: fs.readFileSync,
  setInterval,
  clearInterval,
};

function __setDeps(newDeps) {
  deps = { ...deps, ...newDeps };
}

// ── Constants ──────────────────────────────────────────────────────────────
const POLL_INTERVAL = 400;
const PAGE_CHUNK = 64 * 1024; // 64 KB read chunks
const MAX_PAGE_ROWS = 200;
const MAX_PAGE_BYTES = 2 * 1024 * 1024; // 2 MB
const TRUNCATE_THRESHOLD = 4096; // tool result text cap
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

// Split a buffer into lines. Returns { lines: string[], partial: Buffer }.
// `partial` is the trailing bytes after the last newline.
function splitLines(buf) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      lines.push(buf.slice(start, i).toString('utf8'));
      start = i + 1;
    }
  }
  return { lines, partial: buf.slice(start) };
}

// Truncate tool results in a decoded row, marking truncated ones.
function truncateRow(row) {
  if (!row || !row.blocks) return row;
  let changed = false;
  const blocks = row.blocks.map((b) => {
    if (
      b.type === 'tool_result' &&
      typeof b.content === 'string' &&
      b.content.length > TRUNCATE_THRESHOLD
    ) {
      changed = true;
      return {
        ...b,
        content: b.content.slice(0, TRUNCATE_THRESHOLD),
        truncated: true,
        fullRef: { toolUseId: b.tool_use_id },
      };
    }
    return b;
  });
  if (!changed) return row;
  return { ...row, blocks };
}

// ── Tail read ──────────────────────────────────────────────────────────────
// Read backwards from EOF, collecting up to MAX_PAGE_ROWS rows or
// MAX_PAGE_BYTES, whichever comes first. Returns { rows, pageStart }.
function tailRead(fd, fileSize, decodeLine) {
  if (fileSize === 0) return { rows: [], pageStart: 0, state: {} };

  let cursor = fileSize;
  let bytesUsed = 0;
  let remainingBuffer = Buffer.alloc(0);
  const allLines = [];

  while (cursor > 0 && allLines.length < MAX_PAGE_ROWS && bytesUsed < MAX_PAGE_BYTES) {
    const chunkStart = Math.max(0, cursor - PAGE_CHUNK);
    const chunkLen = cursor - chunkStart;
    const buf = readRange(fd, chunkStart, chunkLen);
    bytesUsed += chunkLen;

    const combined = Buffer.concat([buf, remainingBuffer]);
    let end = combined.length;
    const linesInChunk = [];

    // Process backwards to safely handle partial lines
    for (let i = combined.length - 1; i >= 0; i--) {
      if (combined[i] === 0x0a) {
        linesInChunk.unshift(combined.slice(i + 1, end).toString('utf8'));
        end = i;
      }
    }

    remainingBuffer = combined.slice(0, end);
    allLines.unshift(...linesInChunk);
    cursor = chunkStart;
  }

  if (cursor === 0 && remainingBuffer.length > 0) {
    allLines.unshift(remainingBuffer.toString('utf8'));
    remainingBuffer = Buffer.alloc(0);
  }

  const state = {};
  const decoded = [];
  for (const line of allLines) {
    if (!line.trim()) continue;
    const row = decodeLine(line, state);
    if (row) {
      if (Array.isArray(row)) decoded.push(...row.map(truncateRow));
      else decoded.push(truncateRow(row));
    }
  }

  const pageStart = cursor + remainingBuffer.length;
  return { rows: decoded, pageStart, state };
}

// ── Older page ─────────────────────────────────────────────────────────────
// `results` holds the orphan tool results newer pages already decoded, so a
// call paged in here picks its result up.
function loadOlderPage(fd, pageStart, decodeLine, results = {}) {
  if (pageStart <= 0) return { rows: [], pageStart: 0, atStart: true };

  let cursor = pageStart;
  let bytesUsed = 0;
  let remainingBuffer = Buffer.alloc(0);
  const allLines = [];

  while (cursor > 0 && allLines.length < MAX_PAGE_ROWS && bytesUsed < MAX_PAGE_BYTES) {
    const chunkStart = Math.max(0, cursor - PAGE_CHUNK);
    const chunkLen = cursor - chunkStart;
    const buf = readRange(fd, chunkStart, chunkLen);
    bytesUsed += chunkLen;

    const combined = Buffer.concat([buf, remainingBuffer]);
    let end = combined.length;
    const linesInChunk = [];

    for (let i = combined.length - 1; i >= 0; i--) {
      if (combined[i] === 0x0a) {
        linesInChunk.unshift(combined.slice(i + 1, end).toString('utf8'));
        end = i;
      }
    }

    remainingBuffer = combined.slice(0, end);
    allLines.unshift(...linesInChunk);
    cursor = chunkStart;
  }

  if (cursor === 0 && remainingBuffer.length > 0) {
    allLines.unshift(remainingBuffer.toString('utf8'));
    remainingBuffer = Buffer.alloc(0);
  }

  const state = { results };
  const decoded = [];
  for (const line of allLines) {
    if (!line.trim()) continue;
    const row = decodeLine(line, state);
    if (row) {
      if (Array.isArray(row)) decoded.push(...row.map(truncateRow));
      else decoded.push(truncateRow(row));
    }
  }

  const newPageStart = cursor + remainingBuffer.length;
  return { rows: decoded, pageStart: newPageStart, atStart: newPageStart <= 0 };
}

// ── Fetch full tool result ─────────────────────────────────────────────────
function fetchFull(fd, fileSize, toolUseId) {
  // Scan the entire file for the tool result with this tool_use_id
  let cursor = 0;
  let partial = Buffer.alloc(0);

  while (cursor < fileSize) {
    const chunkLen = Math.min(PAGE_CHUNK, fileSize - cursor);
    const buf = readRange(fd, cursor, chunkLen);
    cursor += chunkLen;

    const combined = Buffer.concat([partial, buf]);
    const { lines, partial: remainder } = splitLines(combined);
    partial = remainder;

    for (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      // Look for tool_result blocks
      if (record.type !== 'user' || !Array.isArray(record.message?.content)) continue;
      const block = record.message.content.find(
        (b) => b.type === 'tool_result' && b.tool_use_id === toolUseId
      );
      if (block) {
        const content = toolResultText(block.content);
        return content.length > FETCH_FULL_CAP
          ? content.slice(0, FETCH_FULL_CAP)
          : content;
      }
    }
  }
  return null;
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

function augmentToolRows(rows, subagents) {
  for (const row of rows) {
    if (row.role === 'tool' && row.tool_use) {
      for (const sub of subagents.values()) {
        if (sub.toolUseId === row.tool_use.id) {
          row.subagent = {
            agentId: sub.agentId,
            type: sub.type,
            description: sub.description,
          };
          row.subagentCount = sub.state?.toolUseCount || 0;
        }
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
      parentRow.subagent = {
        agentId,
        type: meta.agentType,
        description: meta.description,
      };
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
  const running = !!parentRow && !parentRow.result;
  if (!running && !sub.expanded) return closeSubagent(sub);

  const nested = (rows) => rows.map((r) => ({ ...r, parentId: sub.toolUseId }));
  const reportCount = () => {
    if (parentRow && sub.state.toolUseCount !== undefined) {
      parentRow.subagentCount = sub.state.toolUseCount;
      watch.onRows([parentRow]);
    }
  };

  const subPath = path.join(subagentDir(watch), `agent-${sub.agentId}.jsonl`);
  try {
    if (sub.fd === null) {
      sub.fd = deps.openSync(subPath, 'r');
      const complete = completeLength(sub.fd, deps.statSync(subPath).size);
      const { rows, pageStart, state } = tailRead(sub.fd, complete, watch.decodeLine);
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
    const { lines, partial } = splitLines(buf);
    sub.tailOffset += buf.length - partial.length;
    const newRows = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const row = watch.decodeLine(line, sub.state);
      if (row) newRows.push(...[row].flat().map(truncateRow));
    }
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
      onRows(watch.currentRows, watch.state);
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

  // Initial tail read
  const complete = completeLength(fd, stat.size);
  const { rows, pageStart, state } = tailRead(fd, complete, decodeLine);
  watch.currentRows = rows;
  watch.pageStart = pageStart;
  watch.state = state;
  watch.tailOffset = complete;

  if (rows.length > 0) {
    onRows(rows, watch.state);
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
        const { lines, partial } = splitLines(buf);
        watch.tailOffset += buf.length - partial.length;
        const newRows = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          const row = watch.decodeLine(line, watch.state);
          if (row) {
            if (Array.isArray(row)) newRows.push(...row.map(truncateRow));
            else newRows.push(truncateRow(row));
          }
        }

        if (newRows.length > 0) {
          augmentToolRows(newRows, watch.subagents);
          watch.currentRows.push(...newRows);
          onRows(newRows, watch.state);
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
    watch.state.results
  );
  watch.pageStart = pageStart;

  if (rows.length > 0) {
    // Subagents are discovered from the folder, not the page: an Agent call
    // paged in now may already have one.
    augmentToolRows(rows, watch.subagents);
    watch.currentRows.unshift(...rows);
  }

  return { rows, atStart };
}

function chatFetchFull(sessionId, toolUseId) {
  const watch = watches.get(sessionId);
  if (!watch) return null;
  return fetchFull(watch.fd, watch.fileSize, toolUseId);
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
    watch.decodeLine
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
    ...[...watch.subagents.values()].map((sub) =>
      path.join(subagentDir(watch), `agent-${sub.agentId}.jsonl`)
    ),
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
  // Exposed for testing
  MAX_PAGE_ROWS,
  MAX_PAGE_BYTES,
  TRUNCATE_THRESHOLD,
  FETCH_FULL_CAP,
};
