import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import agents from '../electron/services/agents.cjs';

// Session output fan-out (#139): each Session's output goes to any number of
// subscribers — replay, then live chunks, then exit. Driven through the
// module's own seam (.cjs loads out of vi.mock's reach), with a fake pty and
// a temp home, like the floating and split tests.

function fakePty() {
  const handlers = { data: [], exit: [] };
  return {
    spawnedWith: null,
    onData: (cb) => handlers.data.push(cb),
    onExit: (cb) => handlers.exit.push(cb),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    emitData: (d) => handlers.data.forEach((cb) => cb(d)),
    emitExit: (code) => handlers.exit.forEach((cb) => cb({ exitCode: code })),
  };
}

function fakeWin() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: { send: vi.fn() },
  };
}

function subscribe(sessionId) {
  const events = [];
  const unsubscribe = agents.subscribeOutput(sessionId, {
    onReplay: ({ data, exited }) => events.push({ type: 'replay', data, exited }),
    onData: (data) => events.push({ type: 'data', data }),
    onExit: (code) => events.push({ type: 'exit', code }),
  });
  return { events, unsubscribe };
}

let home;
let ptys;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-output-'));
  fs.mkdirSync(path.join(home, 'code'));
  ptys = [];
  agents.__setDeps({
    spawnPty: (file, args, opts) => {
      const p = fakePty();
      p.spawnedWith = { file, args, opts };
      ptys.push(p);
      return p;
    },
    shellEnv: () => ({ PATH: '/usr/bin' }),
    userShell: () => '/bin/zsh',
    homedir: () => home,
  });
});

afterEach(() => {
  agents.stopAll();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('subscribeOutput fan-out', () => {
  it('two subscribers both receive replay, identical live chunks in order, then exit', () => {
    const { sessionId } = agents.launchFloating({ cwd: home });
    const a = subscribe(sessionId);
    const b = subscribe(sessionId);

    ptys[0].emitData('hello ');
    ptys[0].emitData('world');
    ptys[0].emitExit(0);

    const expected = [
      { type: 'replay', data: '', exited: false },
      { type: 'data', data: 'hello ' },
      { type: 'data', data: 'world' },
      { type: 'exit', code: 0 },
    ];
    expect(a.events).toEqual(expected);
    expect(b.events).toEqual(expected);
  });

  it('a subscriber added mid-stream gets a replay of the buffer, then only later chunks', () => {
    const { sessionId } = agents.launchFloating({ cwd: home });
    const early = subscribe(sessionId);

    ptys[0].emitData('hello ');
    ptys[0].emitData('world');

    const late = subscribe(sessionId);
    expect(late.events).toEqual([{ type: 'replay', data: 'hello world', exited: false }]);

    ptys[0].emitData('!');

    expect(early.events).toEqual([
      { type: 'replay', data: '', exited: false },
      { type: 'data', data: 'hello ' },
      { type: 'data', data: 'world' },
      { type: 'data', data: '!' },
    ]);
    expect(late.events).toEqual([
      { type: 'replay', data: 'hello world', exited: false },
      { type: 'data', data: '!' },
    ]);
  });

  it('delivers replay synchronously, so no live chunk comes before it', () => {
    const { sessionId } = agents.launchFloating({ cwd: home });
    const order = [];
    const unsubscribe = agents.subscribeOutput(sessionId, {
      onReplay: () => order.push('replay'),
      onData: () => order.push('data'),
      onExit: () => order.push('exit'),
    });

    // Replay already arrived, before any live output.
    expect(order).toEqual(['replay']);

    ptys[0].emitData('x');
    ptys[0].emitExit(1);
    expect(order).toEqual(['replay', 'data', 'exit']);
    unsubscribe();
  });

  it('unsubscribing stops delivery to that subscriber only, leaving the Session alive', () => {
    const { sessionId } = agents.launchFloating({ cwd: home });
    const a = subscribe(sessionId);
    const b = subscribe(sessionId);

    a.unsubscribe();
    ptys[0].emitData('after');

    expect(a.events).toEqual([{ type: 'replay', data: '', exited: false }]);
    expect(b.events).toEqual([
      { type: 'replay', data: '', exited: false },
      { type: 'data', data: 'after' },
    ]);

    // The Session itself is untouched: still listed, still exits normally.
    expect(agents.getSession(sessionId)).not.toBeNull();
    ptys[0].emitExit(0);
    expect(b.events.at(-1)).toEqual({ type: 'exit', code: 0 });
    expect(
      agents.listFloatingSessions().find((s) => s.sessionId === sessionId)
    ).toMatchObject({ exited: true, exitCode: 0 });
  });

  it('a throwing subscriber does not stop delivery to the others', () => {
    const { sessionId } = agents.launchFloating({ cwd: home });

    const good = subscribe(sessionId);
    const badUnsub = agents.subscribeOutput(sessionId, {
      onReplay: () => {
        throw new Error('replay boom');
      },
      onData: () => {
        throw new Error('data boom');
      },
      onExit: () => {
        throw new Error('exit boom');
      },
    });
    const late = subscribe(sessionId);

    expect(() => ptys[0].emitData('chunk')).not.toThrow();
    expect(() => ptys[0].emitExit(2)).not.toThrow();

    expect(good.events).toEqual([
      { type: 'replay', data: '', exited: false },
      { type: 'data', data: 'chunk' },
      { type: 'exit', code: 2 },
    ]);
    expect(late.events).toEqual(good.events);
    badUnsub();
  });
});

describe('desktop window attach stays byte-for-byte the same', () => {
  it('attach sends replay, then forwards data and exit with the same messages', () => {
    const { sessionId } = agents.launchFloating({ cwd: home });
    const win = fakeWin();

    expect(agents.attach(sessionId, win)).toEqual({ ok: true });
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).toHaveBeenNthCalledWith(1, 'terminal-replay', {
      sessionId,
      data: '',
      exited: false,
    });

    ptys[0].emitData('ls\n');
    expect(win.webContents.send).toHaveBeenNthCalledWith(2, 'terminal-data', {
      sessionId,
      data: 'ls\n',
    });

    ptys[0].emitExit(3);
    expect(win.webContents.send).toHaveBeenNthCalledWith(3, 'terminal-exit', {
      sessionId,
      code: 3,
    });
    expect(win.webContents.send).toHaveBeenCalledTimes(3);
  });

  it('re-attach replaces the window subscription instead of doubling delivery', () => {
    const { sessionId } = agents.launchFloating({ cwd: home });
    const first = fakeWin();
    agents.attach(sessionId, first);
    ptys[0].emitData('one');

    const second = fakeWin();
    agents.attach(sessionId, second);
    // The new window replays the buffer up to the re-attach point.
    expect(second.webContents.send).toHaveBeenNthCalledWith(1, 'terminal-replay', {
      sessionId,
      data: 'one',
      exited: false,
    });

    ptys[0].emitData('two');
    ptys[0].emitExit(0);

    // The old window got nothing after the re-attach — no doubled chunks.
    expect(first.webContents.send).toHaveBeenCalledTimes(2);
    expect(second.webContents.send).toHaveBeenCalledTimes(3);
    expect(second.webContents.send).toHaveBeenNthCalledWith(2, 'terminal-data', {
      sessionId,
      data: 'two',
    });
    expect(second.webContents.send).toHaveBeenNthCalledWith(3, 'terminal-exit', {
      sessionId,
      code: 0,
    });
  });

  it('a destroyed window receives nothing further and never throws', () => {
    const { sessionId } = agents.launchFloating({ cwd: home });
    const win = fakeWin();
    agents.attach(sessionId, win);
    win.isDestroyed.mockReturnValue(true);

    expect(() => ptys[0].emitData('x')).not.toThrow();
    expect(() => ptys[0].emitExit(0)).not.toThrow();
    // Only the initial replay, sent while the window was alive.
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
  });

  it('a Site Session attaches the same way as a floating one', () => {
    const site = { id: 'shop', name: 'Shop', path: path.join(home, 'code') };
    const { sessionId } = agents.launch({ site, agentId: agents.SHELL_ID });
    const win = fakeWin();

    agents.attach(sessionId, win);
    ptys[0].emitData('hi');
    expect(win.webContents.send).toHaveBeenNthCalledWith(1, 'terminal-replay', {
      sessionId,
      data: '',
      exited: false,
    });
    expect(win.webContents.send).toHaveBeenNthCalledWith(2, 'terminal-data', {
      sessionId,
      data: 'hi',
    });
  });
});
