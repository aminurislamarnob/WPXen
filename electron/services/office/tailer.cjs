'use strict';

// ── File tailer ──────────────────────────────────────────────
// One-time faithful port of claude-agent-verse packages/server/src/tailer.ts.
// Tails one JSONL file: an initial read from byte 0 (the cold-start replay of
// a whole transcript), then fs.watch-driven delta reads. Append-aware,
// truncation-safe (size < position resets), defensive JSONL parsing
// (unparseable lines are dropped), and a retry loop while the file doesn't
// exist yet — transcripts are created after the registry entry appears.
// Electron-free: plain node APIs only.

const { EventEmitter } = require('node:events');
const fs = require('node:fs');

/** How long to wait before retrying a file that doesn't exist yet. */
const RETRY_MS = 1000;

class FileTailer extends EventEmitter {
  /**
   * @param {string} filePath
   * @param {{ retryMs?: number }} [opts] retryMs is a test seam; the product
   *   value stays the source's 1 s.
   */
  constructor(filePath, opts = {}) {
    super();
    this.filePath = filePath;
    this.retryMs = opts.retryMs ?? RETRY_MS;
    this.position = 0;
    this.buffer = '';
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

    await this.read();
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
    const stats = await this.fh.stat();
    if (stats.size > this.position) {
      const sizeToRead = stats.size - this.position;
      const buf = Buffer.alloc(sizeToRead);
      const { bytesRead } = await this.fh.read(buf, 0, sizeToRead, this.position);
      if (bytesRead > 0) {
        this.position += bytesRead;
        this.buffer += buf.toString('utf8');
        this.processBuffer();
      }
    } else if (stats.size < this.position) {
      // File was truncated
      this.position = stats.size;
      this.buffer = '';
    }
  }

  processBuffer() {
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.trim()) {
        try {
          const parsed = JSON.parse(line);
          this.emit('line', parsed);
        } catch {
          // ignore unparseable lines defensively
        }
      }
    }
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

module.exports = { FileTailer };
