import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import agents from '../electron/services/agents.cjs';
import { createInAppTerminalProvider } from '../electron/services/terminalProvider.cjs';

function fakePtyFactory(ptys) {
  let nextPid = 2000;
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

/**
 * Reusable behavioural contract suite for any terminal provider (in-app pty or
 * Session Host client). A later ticket (#231) imports and runs this same suite
 * against the Session Host client.
 *
 * `makeFixture` returns `{ provider, emitData(sessionId, chunk), emitExit(sessionId, code),
 * getSpawned(sessionId), advanceKillGrace(), cleanup() }`.
 */
export function runTerminalProviderSuite(name, makeFixture) {
  describe(`terminal provider contract: ${name}`, () => {
    let fx;

    beforeEach(async () => {
      fx = await makeFixture();
    });

    afterEach(async () => {
      await fx?.cleanup?.();
    });

    it('starts a Session, forwards writes and resizes, and emits output in order', async () => {
      const output = [];
      const off = fx.provider.onOutput(({ sessionId, data }) => {
        output.push([sessionId, data]);
      });

      const started = await fx.provider.start({
        sessionId: 's-1',
        file: '/bin/zsh',
        args: ['-il'],
        cwd: '/tmp',
        cols: 80,
        rows: 24,
        env: { TERM: 'xterm-256color' },
      });
      expect(started.pid).toEqual(expect.any(Number));

      await fx.provider.write('s-1', 'ls -la\r');
      await fx.provider.resize('s-1', 120, 40);

      const spawned = fx.getSpawned('s-1');
      if (spawned) {
        expect(spawned.write).toHaveBeenCalledWith('ls -la\r');
        expect(spawned.resize).toHaveBeenCalledWith(120, 40);
      }

      await fx.emitData('s-1', 'first ');
      await fx.emitData('s-1', 'second ');
      await fx.emitData('s-1', 'third');

      expect(output).toEqual([
        ['s-1', 'first '],
        ['s-1', 'second '],
        ['s-1', 'third'],
      ]);
      off();
    });

    it('replays buffered output in order on attach and reports exited state', async () => {
      await fx.provider.start({
        sessionId: 's-attach',
        file: '/bin/zsh',
        args: ['-il'],
        cwd: '/tmp',
      });
      await fx.emitData('s-attach', 'hello ');
      await fx.emitData('s-attach', 'world');

      const snap = await fx.provider.attach('s-attach');
      expect(snap).toMatchObject({ data: 'hello world', exited: false });

      await fx.emitExit('s-attach', 0);
      const afterExit = await fx.provider.attach('s-attach');
      expect(afterExit).toMatchObject({ data: 'hello world', exited: true, exitCode: 0 });
    });

    it('delivers exactly one exit event and ignores output after exit', async () => {
      const exits = [];
      const outputs = [];
      fx.provider.onExit((ev) => exits.push(ev));
      fx.provider.onOutput((ev) => outputs.push(ev));

      await fx.provider.start({
        sessionId: 's-exit',
        file: '/bin/zsh',
        args: ['-il'],
        cwd: '/tmp',
      });
      await fx.emitData('s-exit', 'before-exit');
      await fx.emitExit('s-exit', 7);
      // Duplicate exit or late output from an underlying pty must be suppressed.
      await fx.emitExit('s-exit', 9);
      await fx.emitData('s-exit', 'after-exit');

      expect(exits).toEqual([{ sessionId: 's-exit', exitCode: 7 }]);
      expect(outputs).toEqual([{ sessionId: 's-exit', data: 'before-exit' }]);
    });

    it('stops a running Session with SIGTERM and escalates to SIGKILL if it does not exit', async () => {
      await fx.provider.start({
        sessionId: 's-stop',
        file: '/bin/zsh',
        args: ['-il'],
        cwd: '/tmp',
      });
      const spawned = fx.getSpawned('s-stop');
      await fx.provider.stop('s-stop');

      if (spawned) {
        expect(spawned.kill).toHaveBeenCalledWith('SIGTERM');
        await fx.advanceKillGrace();
        expect(spawned.kill).toHaveBeenCalledWith('SIGKILL');
      }
    });
  });
}

runTerminalProviderSuite('in-app pty provider', () => {
  vi.useFakeTimers();
  const ptys = [];
  const byId = new Map();
  const spawn = fakePtyFactory(ptys);
  const provider = createInAppTerminalProvider({
    spawnPty: (file, args, opts) => {
      const p = spawn(file, args, opts);
      return p;
    },
  });
  const origStart = provider.start.bind(provider);
  provider.start = (opts) => {
    const res = origStart(opts);
    byId.set(opts.sessionId, ptys.at(-1));
    return res;
  };
  return {
    provider,
    emitData: (id, data) => byId.get(id)?.emitData(data),
    emitExit: (id, code) => byId.get(id)?.emitExit(code),
    getSpawned: (id) => byId.get(id),
    advanceKillGrace: () => vi.advanceTimersByTime(3500),
    cleanup: () => {
      provider.stopAll();
      vi.useRealTimers();
    },
  };
});

describe('Session engine over the terminal provider (#229)', () => {
  it('agents.cjs does not require node-pty directly', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../electron/services/agents.cjs'),
      'utf8'
    );
    expect(src).not.toMatch(/require\(['"]node-pty['"]\)/);
  });

  it('routes both Site Agent Sessions and Floating Workspace terminals through the injected provider', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-provider-engine-'));
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\ntrue\n');
    fs.chmodSync(path.join(bin, 'claude'), 0o755);

    const ptys = [];
    const baseProvider = createInAppTerminalProvider({
      spawnPty: fakePtyFactory(ptys),
    });
    const spyStart = vi.spyOn(baseProvider, 'start');
    const spyWrite = vi.spyOn(baseProvider, 'write');
    const spyResize = vi.spyOn(baseProvider, 'resize');
    const spyStop = vi.spyOn(baseProvider, 'stop');

    agents.__setDeps({
      terminalProvider: baseProvider,
      shellEnv: () => ({ PATH: `${bin}:/usr/bin` }),
      userShell: () => '/bin/zsh',
      homedir: () => home,
      sitePhpBin: () => null,
    });

    try {
      const siteRes = agents.launch({
        site: { id: 'shop', name: 'Shop', path: home },
        agentId: 'claude',
      });
      const floatRes = agents.launchFloating({ cwd: home });

      expect(siteRes.ok).toBe(true);
      expect(floatRes.ok).toBe(true);
      expect(spyStart).toHaveBeenCalledTimes(2);

      agents.write(siteRes.sessionId, 'hello');
      expect(spyWrite).toHaveBeenCalledWith(siteRes.sessionId, 'hello');

      agents.resize(floatRes.sessionId, 100, 30);
      expect(spyResize).toHaveBeenCalledWith(floatRes.sessionId, 100, 30);

      agents.stop(siteRes.sessionId);
      expect(spyStop).toHaveBeenCalledWith(siteRes.sessionId);
    } finally {
      agents.stopAll();
      agents.__setDeps({ terminalProvider: null });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
