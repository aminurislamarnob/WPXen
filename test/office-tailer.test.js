import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileTailer } from '../electron/services/office/tailer.cjs';

// One-time port coverage for claude-agent-verse packages/server/src/tailer.ts:
// append-aware, truncation-safe, defensive JSONL parsing, retry while the file
// doesn't exist. All content is synthetic. Appends go through the real
// filesystem (fs.watch is the mechanism under test), so assertions poll.

const until = async (fn, timeout = 4000) => {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeout) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

// macOS FSEvents drops writes that land before its watcher thread is live, so
// give a freshly started tailer a beat before the single-shot appends below.
// Real transcripts keep streaming, so the product never notices this window.
const settle = () => new Promise((r) => setTimeout(r, 150));

let dir;
let file;
let tailer;
let lines;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-tailer-'));
  file = path.join(dir, 'transcript.jsonl');
  lines = [];
});

afterEach(() => {
  tailer?.stop();
  tailer = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

function tail(target = file, opts) {
  tailer = new FileTailer(target, opts);
  tailer.on('line', (line) => lines.push(line));
  return tailer.start();
}

describe('FileTailer', () => {
  it('replays the existing file from byte 0, then emits appended lines', async () => {
    fs.writeFileSync(file, '{"n":1}\n{"n":2}\n');
    await tail();
    expect(lines).toEqual([{ n: 1 }, { n: 2 }]);

    await settle();
    fs.appendFileSync(file, '{"n":3}\n');
    await until(() => lines.length === 3);
    expect(lines[2]).toEqual({ n: 3 });
  });

  it('keeps a partial trailing line buffered until its newline arrives', async () => {
    fs.writeFileSync(file, '{"n":1}\n{"n":');
    await tail();
    expect(lines).toEqual([{ n: 1 }]);

    await settle();
    fs.appendFileSync(file, '2}\n');
    await until(() => lines.length === 2);
    expect(lines[1]).toEqual({ n: 2 });
  });

  it('ignores unparseable and blank lines, keeping later lines flowing', async () => {
    fs.writeFileSync(file, '{"n":1}\nnot json at all\n\n{"n":2}\n');
    await tail();
    expect(lines).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('survives truncation: resets to the new size and reads fresh writes', async () => {
    fs.writeFileSync(file, '{"n":1}\n{"n":2}\n');
    await tail();
    expect(lines).toHaveLength(2);

    await settle();
    fs.truncateSync(file, 0);
    // Let the reset land first: the tailer sees size < position and rewinds,
    // then the next write is read from the top.
    await settle();
    fs.writeFileSync(file, '{"n":9}\n');
    await until(() => lines.length === 3);
    expect(lines[2]).toEqual({ n: 9 });
  });

  it('retries while the file does not exist yet, then tails it', async () => {
    await tail(file, { retryMs: 25 });
    expect(lines).toEqual([]);

    fs.writeFileSync(file, '{"n":1}\n');
    await until(() => lines.length === 1);
    expect(lines[0]).toEqual({ n: 1 });
  });

  it('stop() during the missing-file retry window stays stopped', async () => {
    await tail(file, { retryMs: 25 });
    tailer.stop();
    fs.writeFileSync(file, '{"n":1}\n');
    await new Promise((r) => setTimeout(r, 120));
    expect(lines).toEqual([]);
  });
});
