'use strict';

// ── File tailer ──────────────────────────────────────────────
// One-time faithful port of claude-agent-verse packages/server/src/tailer.ts.
// Tails one JSONL file: an initial replay of the file's last REPLAY_BYTES
// (the cold-start read), then fs.watch-driven delta reads. Append-aware,
// truncation-safe (size < position resets), defensive JSONL parsing
// (unparseable lines are dropped), and a retry loop while the file doesn't
// exist yet — transcripts are created after the registry entry appears.
// Electron-free: plain node APIs only.
//
// ⚠️ Runs in the main process, where real transcripts reach 200 MB. Reading
// one whole (the source's byte-0 replay) froze the app for ~300 ms and spiked
// RSS to ~900 MB with a handful of live sessions. So the cold start replays
// only the tail — every field the Office derives (state, current tool, the
// 20-entry feed, and the ai-title / last-prompt lines Claude Code re-appends
// all through a transcript) is recoverable from its end — and every read goes
// in CHUNK_BYTES slices that yield to the event loop between them.

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');

/** How long to wait before retrying a file that doesn't exist yet. */
const RETRY_MS = 1000;
/** How much of an existing file the cold start replays: its last 4 MiB. */
const REPLAY_BYTES = 4 * 1024 * 1024;
/** Largest single read; the event loop gets a turn between slices. */
const CHUNK_BYTES = 1024 * 1024;

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

class FileTailer extends EventEmitter {
  /**
   * @param {string} filePath
   * @param {{ retryMs?: number, replayBytes?: number, chunkBytes?: number }} [opts]
   *   Test seams; the product values are RETRY_MS, REPLAY_BYTES, CHUNK_BYTES.
   */
  constructor(filePath, opts = {}) {
    super();
    this.filePath = filePath;
    this.retryMs = opts.retryMs ?? RETRY_MS;
    this.replayBytes = opts.replayBytes ?? REPLAY_BYTES;
    this.chunkBytes = opts.chunkBytes ?? CHUNK_BYTES;
    this.position = 0;
    this.buffer = '';
    // A read can end inside a multi-byte character; the decoder holds its
    // first bytes until the rest arrive instead of emitting U+FFFD.
    this.decoder = new StringDecoder('utf8');
    /** True until the first newline when the replay starts mid-file. */
    this.skipPartial = false;
    /** @type {import('node:fs/promises').FileHandle | null} */
    this.fh = null;
    /** @type {fs.FSWatcher | null} */
    this.watcher = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.retry = null;
    this.stopped = false;
    /** @type {Promise<void> | null} */
    this.reading = null;
    this.pending = false;
  }

  async start() {
    if (this.stopped) return;
    try {
      this.fh = await fs.promises.open(this.filePath, 'r');
    } catch (e) {
      if (e.code === 'ENOENT') {
        // Retry shortly if the file isn't created yet.
        this.retry = setTimeout(() => this.start(), this.retryMs);
        return;
      }
      throw e;
    }
    if (this.stopped) {
      await this.fh.close().catch(() => {});
      this.fh = null;
      return;
    }

    // Start the replay at the tail. Begin one byte early and drop everything
    // up to the first newline: if that byte is itself a newline only it is
    // dropped, otherwise the cut-off line is.
    const { size } = await this.fh.stat();
    if (size > this.replayBytes) {
      this.position = size - this.replayBytes - 1;
      this.skipPartial = true;
    }

    await this.read();
    if (this.stopped) return;
    this.watcher = fs.watch(this.filePath, (eventType) => {
      if (eventType === 'change') void this.read();
    });
  }

  /** Reads one chunk at a time; changes that arrive mid-read are picked up right after. */
  async read() {
    if (this.reading) {
      this.pending = true;
      return this.reading;
    }
    this.reading = (async () => {
      do {
        this.pending = false;
        try {
          await this.readNewData();
        } catch {
          // the file vanished or was closed under us; the next change retries
        }
      } while (this.pending && this.fh !== null);
    })();
    try {
      await this.reading;
    } finally {
      this.reading = null;
    }
  }

  async readNewData() {
    if (this.fh === null) return;
    const { size } = await this.fh.stat();
    if (size < this.position) {
      // File was truncated
      this.position = size;
      this.buffer = '';
      this.decoder = new StringDecoder('utf8');
      this.skipPartial = false;
      return;
    }
    let first = true;
    while (this.fh !== null && size > this.position) {
      if (!first) await yieldToEventLoop();
      first = false;
      if (this.fh === null) return;
      const length = Math.min(size - this.position, this.chunkBytes);
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await this.fh.read(buf, 0, length, this.position);
      if (bytesRead <= 0) return;
      this.position += bytesRead;
      this.buffer += this.decoder.write(buf.subarray(0, bytesRead));
      this.processBuffer();
    }
  }

  processBuffer() {
    let start = 0;
    let newlineIndex;
    if (this.skipPartial) {
      newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex < 0) return;
      start = newlineIndex + 1;
      this.skipPartial = false;
    }
    while ((newlineIndex = this.buffer.indexOf('\n', start)) >= 0) {
      const line = this.buffer.slice(start, newlineIndex);
      start = newlineIndex + 1;
      if (this.stopped) break;
      if (line.trim()) {
        try {
          const parsed = JSON.parse(line);
          this.emit('line', parsed);
        } catch {
          // ignore unparseable lines defensively
        }
      }
    }
    // Copy the remainder rather than slicing: a slice keeps the whole chunk alive.
    this.buffer =
      start === 0 ? this.buffer : Buffer.from(this.buffer.slice(start)).toString();
  }

  stop() {
    this.stopped = true;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.fh !== null) {
      this.fh.close().catch(() => {});
      this.fh = null;
    }
  }
}

module.exports = { FileTailer, REPLAY_BYTES, CHUNK_BYTES };
