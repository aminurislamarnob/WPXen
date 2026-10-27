import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import agents from '../electron/services/agents.cjs';
import { snapshotBuffer } from '../electron/services/ansi.cjs';
import { shouldShowWaitingFallback } from '../src/lib/chatRows.js';

describe('snapshotBuffer', () => {
  it('strips ANSI escapes and truncates to N lines', () => {
    const buffer = 'Loading...\n\x1b[31mError!\x1b[0m\nLine 3\nLine 4\nLine 5';
    const snapshot = snapshotBuffer(buffer, 3);
    expect(snapshot).toBe(
      'Error!\nLine 3\nLine 4\nLine 5'.split('\n').slice(-3).join('\n')
    );
  });

  it('collapses \\r overwrites correctly', () => {
    const buffer = 'Progress 10%\rProgress 50%\rProgress 100%\nDone.';
    const snapshot = snapshotBuffer(buffer, 5);
    expect(snapshot).toBe('Progress 100%\nDone.');
  });

  it('strips single escapes and OSC sequences', () => {
    const buffer = 'OSC\x1b]8;;http://example.com\x07Link\x1b]8;;\x07\nSingle\x1bcEscape';
    const snapshot = snapshotBuffer(buffer, 5);
    expect(snapshot).toBe('OSCLink\nSingleEscape');
  });

  it('skips empty lines', () => {
    const buffer = 'Line 1\n\n\nLine 2';
    const snapshot = snapshotBuffer(buffer, 5);
    expect(snapshot).toBe('Line 1\nLine 2');
  });
});

describe('shouldShowWaitingFallback', () => {
  it('returns false if status is not needs-input', () => {
    expect(shouldShowWaitingFallback('running', [])).toBe(false);
    expect(shouldShowWaitingFallback('stopped', [])).toBe(false);
  });

  it('returns true if status is needs-input and no AskUserQuestion tool run is waiting', () => {
    const messages = [
      {
        role: 'tool-run',
        items: [{ tool_use: { name: 'bash' } }, { result: { content: 'done' } }],
      },
    ];
    expect(shouldShowWaitingFallback('needs-input', messages)).toBe(true);
  });

  it('returns false if AskUserQuestion tool is pending (no result)', () => {
    const messages = [
      {
        role: 'tool-run',
        items: [{ tool_use: { name: 'AskUserQuestion' } }],
      },
    ];
    expect(shouldShowWaitingFallback('needs-input', messages)).toBe(false);
  });

  it('returns true if AskUserQuestion tool is completed (has result)', () => {
    const messages = [
      {
        role: 'tool-run',
        items: [
          { tool_use: { name: 'AskUserQuestion' }, result: { content: 'user answered' } },
        ],
      },
    ];
    expect(shouldShowWaitingFallback('needs-input', messages)).toBe(true);
  });
});

describe('shouldShowWaitingFallback — only the latest row counts', () => {
  const ask = (result) => ({
    role: 'tool',
    tool_use: { name: 'AskUserQuestion' },
    result,
  });
  const run = (...items) => ({ role: 'tool-run', items });

  it('shows the row when an old question is still open but newer rows followed', () => {
    const messages = [run(ask()), { role: 'assistant', content: 'moving on' }];
    expect(shouldShowWaitingFallback('needs-input', messages, { cards: true })).toBe(
      true
    );
  });

  it('hides it while the latest row is an open question card', () => {
    const messages = [{ role: 'user', content: 'go' }, run({ role: 'tool' }, ask())];
    expect(shouldShowWaitingFallback('needs-input', messages, { cards: true })).toBe(
      false
    );
  });

  it('shows it for an open question the Agent has no card for', () => {
    const messages = [run(ask())];
    expect(shouldShowWaitingFallback('needs-input', messages, { cards: false })).toBe(
      true
    );
  });
});

// What "Waiting in terminal" shows: the last lines of the Session's own pty
// output, read through agents.chatSnapshot.
describe('agents.chatSnapshot', () => {
  let home;
  let pty;

  beforeEach(() => {
    vi.useFakeTimers();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-snap-'));
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\ntrue\n');
    fs.chmodSync(path.join(bin, 'codex'), 0o755);
    agents.__setDeps({
      spawnPty: () => {
        const handlers = { data: [], exit: [] };
        pty = {
          onData: (cb) => handlers.data.push(cb),
          onExit: (cb) => handlers.exit.push(cb),
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          emit: (d) => handlers.data.forEach((cb) => cb(d)),
        };
        return pty;
      },
      shellEnv: () => ({ PATH: `${bin}:/usr/bin` }),
      userShell: () => '/bin/zsh',
      homedir: () => home,
      sitePhpBin: () => null,
    });
  });
  afterEach(() => {
    agents.stopAll();
    vi.useRealTimers();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("returns the last lines of the Session's output, ANSI stripped", () => {
    const res = agents.launch({ site: { id: 'site-1', path: home }, agentId: 'codex' });
    expect(res.ok).toBe(true);
    pty.emit('% ');
    vi.advanceTimersByTime(500);
    pty.emit('Working\r\n\x1b[1mAllow this command?\x1b[0m\r\n  1. Yes\r\n  2. No\r\n');
    expect(agents.chatSnapshot(res.sessionId, 3)).toBe(
      'Allow this command?\n1. Yes\n2. No'
    );
  });

  it('is empty for a Session that does not exist', () => {
    expect(agents.chatSnapshot('no-such-session', 5)).toBe('');
  });
});
