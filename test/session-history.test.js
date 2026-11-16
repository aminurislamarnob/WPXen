import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import agents from '../electron/services/agents.cjs';
import { createSessionHost } from '../electron/services/sessionHost.cjs';
import { createSessionHostClient } from '../electron/services/sessionHostClient.cjs';
import {
  WPXEN_SESSION_HISTORY_DIR,
  MAX_HISTORY_BYTES,
  historyDir,
  historyFilePath,
  appendHistory,
  readHistory,
  deleteHistory,
} from '../electron/services/sessionHistory.cjs';

const until = async (fn, timeout = 3000) => {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeout) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

function fakePtyFactory(ptys) {
  let nextPid = 7000;
  return (file, args, opts) => {
    const handlers = { data: [], exit: [] };
    const p = {
      pid: (nextPid += 10),
      spawnedWith: { file, args, opts },
      onData: (cb) => handlers.data.push(cb),
      onExit: (cb) => handlers.exit.push(cb),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      emitData: (d) => handlers.data.forEach((cb) => cb(d)),
      emitExit: (code) => handlers.exit.forEach((cb) => cb({ exitCode: code })),
    };
    ptys.push(p);
    return p;
  };
}

function fakeStore(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    get(key, fallback) {
      return key in data ? structuredClone(data[key]) : fallback;
    },
    set(key, value) {
      data[key] = structuredClone(value);
    },
  };
}

describe('terminal history on disk (#233)', () => {
  let tmp;
  let userData;
  let histDir;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-hist-'));
    userData = path.join(tmp, 'userData');
    fs.mkdirSync(userData, { recursive: true });
    histDir = historyDir(userData);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('uses a wpxen-prefixed directory name, mode 0700 folder and mode 0600 files', () => {
    expect(WPXEN_SESSION_HISTORY_DIR).toMatch(/^wpxen/);
    expect(MAX_HISTORY_BYTES).toBe(5 * 1024 * 1024);

    appendHistory(histDir, 'sess-1', 'hello world\n');
    const file = historyFilePath(histDir, 'sess-1');
    expect(fs.statSync(histDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readHistory(histDir, 'sess-1')).toBe('hello world\n');
  });

  it('caps a history file at maxBytes, keeping the newest output', () => {
    const cap = 100;
    appendHistory(histDir, 'sess-cap', 'A'.repeat(60), cap);
    appendHistory(histDir, 'sess-cap', 'B'.repeat(70), cap);

    const file = historyFilePath(histDir, 'sess-cap');
    expect(fs.statSync(file).size).toBeLessThanOrEqual(cap);
    const content = readHistory(histDir, 'sess-cap');
    expect(content).toBe('A'.repeat(30) + 'B'.repeat(70));
  });

  it('reattaching to a live Session replays disk history and continues live with no gap or duplicate', async () => {
    const sockPath = path.join(tmp, 'wpxen-host.sock');
    const ptys = [];
    const host = createSessionHost({
      socketPath: sockPath,
      historyDir: histDir,
      appVersion: '0.6.3',
      spawnPty: fakePtyFactory(ptys),
    });
    await host.start();

    try {
      const c1 = createSessionHostClient({ socketPath: sockPath });
      await c1.start({ sessionId: 's-reattach', file: '/bin/zsh', cwd: tmp });
      ptys[0].emitData('line-1\n');
      ptys[0].emitData('line-2\n');
      await c1.close();

      ptys[0].emitData('while-away\n');

      const c2 = createSessionHostClient({ socketPath: sockPath });
      const live = [];
      c2.onOutput((ev) => live.push(ev.data));
      const snap = await c2.attach('s-reattach');
      expect(snap.data).toBe('line-1\nline-2\nwhile-away\n');

      ptys[0].emitData('live-next\n');
      await until(() => live.length === 1);
      expect(live).toEqual(['live-next\n']);
      await c2.close();
    } finally {
      await host.close();
    }
  });

  it('deletes the history file on stop, on 50-per-Project cap eviction, and for orphaned files at launch', async () => {
    const siteDir = path.join(tmp, 'site');
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(siteDir, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\ntrue\n');
    fs.chmodSync(path.join(bin, 'claude'), 0o755);

    const ptys = [];
    const store = fakeStore();
    let clock = 1_700_000_000_000;

    agents.bindStore(store);
    await agents.setKeepRunningOnQuit(false);
    agents.__setDeps({
      now: () => (clock += 1000),
      spawnPty: fakePtyFactory(ptys),
      shellEnv: () => ({ PATH: `${bin}:/usr/bin` }),
      userShell: () => '/bin/zsh',
      homedir: () => tmp,
      sitePhpBin: () => null,
      userDataDir: () => userData,
    });

    try {
      // 1. Orphaned history file is removed at launch (restoreSessions).
      appendHistory(histDir, 'orphan-session', 'stale secret');
      expect(fs.existsSync(historyFilePath(histDir, 'orphan-session'))).toBe(true);
      agents.restoreSessions({ projectIds: ['site-1'] });
      expect(fs.existsSync(historyFilePath(histDir, 'orphan-session'))).toBe(false);

      // 2. Ended Session restored from disk after host is gone replays saved history read-only.
      store.set(agents.SESSIONS_STORE_KEY, [
        {
          sessionId: 'ended-from-disk',
          siteId: 'site-1',
          agentId: 'claude',
          agentName: 'Claude Code',
          cwd: siteDir,
          title: 'Old run',
          startedAt: clock,
          endedAt: clock + 500,
          exitCode: 0,
          exitState: 'exited',
        },
      ]);
      appendHistory(histDir, 'ended-from-disk', 'saved output from before reboot\n');
      agents.restoreSessions({ projectIds: ['site-1'] });

      const sent = [];
      const fakeWin = {
        isDestroyed: () => false,
        webContents: { send: (ch, payload) => sent.push({ ch, payload }) },
      };
      agents.attach('ended-from-disk', fakeWin);
      expect(sent[0]).toEqual({
        ch: 'terminal-replay',
        payload: {
          sessionId: 'ended-from-disk',
          data: 'saved output from before reboot\n',
          exited: true,
        },
      });

      // 3. Closing a Session deletes its history file.
      agents.stop('ended-from-disk');
      expect(fs.existsSync(historyFilePath(histDir, 'ended-from-disk'))).toBe(false);

      // 4. Dropping a record at the 50-per-Project cap deletes its history file.
      const records = [];
      for (let i = 0; i < 51; i++) {
        const id = `cap-${i}`;
        records.push({
          sessionId: id,
          siteId: 'site-1',
          agentId: 'claude',
          agentName: 'Claude Code',
          cwd: siteDir,
          title: `Run ${i}`,
          startedAt: 1000 + i,
          endedAt: 2000 + i,
          exitCode: 0,
          exitState: 'exited',
        });
        appendHistory(histDir, id, `out-${i}`);
      }
      store.set(agents.SESSIONS_STORE_KEY, records);
      agents.restoreSessions({ projectIds: ['site-1'] });
      expect(fs.existsSync(historyFilePath(histDir, 'cap-0'))).toBe(false);
      expect(fs.existsSync(historyFilePath(histDir, 'cap-50'))).toBe(true);
    } finally {
      agents.stopAll();
      deleteHistory(histDir, 'cap-50');
    }
  });
});
