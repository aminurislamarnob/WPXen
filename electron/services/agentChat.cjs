const fs = require('fs');
const path = require('path');
const { toolResultText } = require('./agentChatClaude.cjs');

let deps = {
  statSync: fs.statSync,
  openSync: fs.openSync,
  readSync: fs.readSync,
  closeSync: fs.closeSync,
  readdirSync: fs.readdirSync,
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
    if (row) decoded.push(truncateRow(row));
  }

  const pageStart = cursor + remainingBuffer.length;
  return { rows: decoded, pageStart, state };
}

// ── Older page ─────────────────────────────────────────────────────────────
function loadOlderPage(fd, pageStart, decodeLine) {
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

  const state = {};
  const decoded = [];
  for (const line of allLines) {
    if (!line.trim()) continue;
    const row = decodeLine(line, state);
    if (row) decoded.push(truncateRow(row));
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
function checkStaleTranscript(watch) {
  if (!watch.transcriptDir || !watch.transcriptId) return false;
  try {
    const files = deps.readdirSync(watch.transcriptDir);
    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));
    for (const f of jsonlFiles) {
      const uuid = f.replace('.jsonl', '');
      if (uuid !== watch.transcriptId) {
        // Check if this file is newer
        const fullPath = path.join(watch.transcriptDir, f);
        try {
          const stat = deps.statSync(fullPath);
          if (stat.mtimeMs > watch.startedAtMs) {
            return true;
          }
        } catch {
          // ignore stat errors on individual files
        }
      }
    }
  } catch {
    // ignore readdir errors
  }
  return false;
}

// ── Open / Close ───────────────────────────────────────────────────────────
function openChat(sessionId, viewerId, opts) {
  const { transcriptPath, onRows, decodeLine, onNotice, transcriptId, startedAt } = opts;

  let watch = watches.get(sessionId);
  if (watch) {
    watch.viewers.add(viewerId);
    // Replay current rows to the new viewer
    if (watch.currentRows.length > 0) {
      onRows(watch.currentRows);
    }
    return;
  }

  const fd = deps.openSync(transcriptPath, 'r');
  const stat = deps.statSync(transcriptPath);

  watch = {
    viewers: new Set([viewerId]),
    path: transcriptPath,
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
    tailOffset: 0, // byte offset for incremental polling after initial tail
  };
  watches.set(sessionId, watch);

  // Initial tail read
  const { rows, pageStart, state } = tailRead(fd, stat.size, decodeLine);
  watch.currentRows = rows;
  watch.pageStart = pageStart;
  watch.state = state;
  watch.tailOffset = stat.size;

  if (rows.length > 0) {
    onRows(rows);
  }

  // Poll for new data
  const poll = () => {
    try {
      const newStat = deps.statSync(watch.path);
      const newSize = newStat.size;

      if (newSize < watch.tailOffset) {
        // File truncated — reset
        watch.tailOffset = 0;
        watch.state = {};
        watch.currentRows = [];
        watch.pageStart = 0;
        watch.staleNotified = false;
        onRows([{ reset: true }]);
        return;
      }

      if (newSize > watch.tailOffset) {
        // Read incremental data
        const length = newSize - watch.tailOffset;
        const buf = readRange(watch.fd, watch.tailOffset, length);
        watch.tailOffset = newSize;
        watch.fileSize = newSize;

        const { lines } = splitLines(buf);
        const newRows = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          const row = watch.decodeLine(line, watch.state);
          if (row) newRows.push(truncateRow(row));
        }

        if (newRows.length > 0) {
          watch.currentRows.push(...newRows);
          onRows(newRows);
        }
      }

      // Check for stale transcript
      if (!watch.staleNotified && checkStaleTranscript(watch)) {
        watch.staleNotified = true;
        onRows([{ notice: true, kind: 'transcript-changed' }]);
      }
    } catch {
      // Missing file or read error
    }
  };

  watch.interval = deps.setInterval(poll, POLL_INTERVAL);
}

function loadOlder(sessionId) {
  const watch = watches.get(sessionId);
  if (!watch) return { rows: [], atStart: true };

  const { rows, pageStart, atStart } = loadOlderPage(
    watch.fd,
    watch.pageStart,
    watch.decodeLine
  );
  watch.pageStart = pageStart;

  if (rows.length > 0) {
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
    if (watch.fd !== null) {
      try {
        deps.closeSync(watch.fd);
      } catch {}
    }
  }
  watches.clear();
}

module.exports = {
  __setDeps,
  openChat,
  closeChat,
  closeAllChats,
  loadOlder,
  chatFetchFull,
  // Exposed for testing
  MAX_PAGE_ROWS,
  MAX_PAGE_BYTES,
  TRUNCATE_THRESHOLD,
  FETCH_FULL_CAP,
};
