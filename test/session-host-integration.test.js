import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import agents from '../electron/services/agents.cjs';
import { createSessionHost } from '../electron/services/sessionHost.cjs';
import { createSessionHostClient } from '../electron/services/sessionHostClient.cjs';
import {
  WPXEN_SESSION_HOST_DIR,
  WPXEN_SESSION_HOST_SOCKET_PREFIX,
  runtimeDirForVersion,
  socketPathForVersion,
  stageRuntimeFiles,
  spawnDetachedHost,
} from '../electron/services/sessionHostManager.cjs';
import { hostFallbackNotice } from '../src/lib/sessionHostNotice.js';

const until = async (fn, timeout = 3000) => {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeout) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

function fakePtyFactory(ptys) {
  let nextPid = 5000;
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

describe('Session Host runtime staging & detached spawn (#231)', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-host-stage-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('uses wpxen-prefixed named constants for the runtime folder and socket', () => {
    expect(WPXEN_SESSION_HOST_DIR).toMatch(/^wpxen/);
    expect(WPXEN_SESSION_HOST_SOCKET_PREFIX).toMatch(/^wpxen/);
    expect(runtimeDirForVersion('/data', '0.6.3')).toBe(
      path.join('/data', WPXEN_SESSION_HOST_DIR, '0.6.3')
    );
    expect(socketPathForVersion('/data', '0.6.3')).toBe(
      path.join('/data', `${WPXEN_SESSION_HOST_SOCKET_PREFIX}0.6.3.sock`)
    );
  });

  it('copies sessionHost.cjs, node-pty JS files, pty.node and executable spawn-helper into the versioned data folder', () => {
    const staged = stageRuntimeFiles({
      userDataDir: tmp,
      version: '0.6.3',
    });

    expect(staged.versionDir).toBe(path.join(tmp, WPXEN_SESSION_HOST_DIR, '0.6.3'));
    expect(fs.existsSync(staged.hostScriptPath)).toBe(true);
    expect(fs.existsSync(path.join(staged.versionDir, 'agentStatus.cjs'))).toBe(true);
    expect(
      fs.existsSync(
        path.join(staged.versionDir, 'node_modules', 'node-pty', 'package.json')
      )
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(staged.versionDir, 'node_modules', 'node-pty', 'lib', 'index.js')
      )
    ).toBe(true);

    const ptyNode = path.join(
      staged.versionDir,
      'node_modules',
      'node-pty',
      'build',
      'Release',
      'pty.node'
    );
    const spawnHelper = path.join(
      staged.versionDir,
      'node_modules',
      'node-pty',
      'build',
      'Release',
      'spawn-helper'
    );
    expect(fs.existsSync(ptyNode)).toBe(true);
    expect(fs.existsSync(spawnHelper)).toBe(true);
    expect(fs.statSync(spawnHelper).mode & 0o111).not.toBe(0);
  });

  it('stages native files from app.asar.unpacked in a packaged build layout', () => {
    const bundleResources = path.join(tmp, 'Resources');
    const asarPty = path.join(bundleResources, 'app.asar', 'node_modules', 'node-pty');
    const unpackedPty = path.join(
      bundleResources,
      'app.asar.unpacked',
      'node_modules',
      'node-pty'
    );
    fs.mkdirSync(path.join(asarPty, 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(asarPty, 'package.json'),
      JSON.stringify({ name: 'node-pty', main: './lib/index.js' })
    );
    fs.writeFileSync(path.join(asarPty, 'lib', 'index.js'), 'module.exports = {};');

    fs.mkdirSync(path.join(unpackedPty, 'build', 'Release'), { recursive: true });
    fs.writeFileSync(path.join(unpackedPty, 'build', 'Release', 'pty.node'), 'native');
    fs.writeFileSync(
      path.join(unpackedPty, 'build', 'Release', 'spawn-helper'),
      '#!/bin/sh\n'
    );

    const userData = path.join(tmp, 'userData');
    const staged = stageRuntimeFiles({
      userDataDir: userData,
      version: '0.6.3',
      nodePtyDir: asarPty,
    });

    const helper = path.join(
      staged.versionDir,
      'node_modules',
      'node-pty',
      'build',
      'Release',
      'spawn-helper'
    );
    expect(fs.existsSync(helper)).toBe(true);
    expect(fs.statSync(helper).mode & 0o755).toBe(0o755);
  });

  it('spawns the host detached under ELECTRON_RUN_AS_NODE=1 from the copied data folder, not the app bundle', () => {
    const staged = stageRuntimeFiles({ userDataDir: tmp, version: '0.6.3' });
    const unref = vi.fn();
    const spawnSpy = vi.fn(() => ({ pid: 9876, unref }));

    const res = spawnDetachedHost({
      versionDir: staged.versionDir,
      hostScriptPath: staged.hostScriptPath,
      socketPath: staged.socketPath,
      version: '0.6.3',
      execPath: '/Applications/WPXen.app/Contents/MacOS/WPXen',
      spawn: spawnSpy,
    });

    expect(res.pid).toBe(9876);
    expect(unref).toHaveBeenCalledTimes(1);
    expect(spawnSpy).toHaveBeenCalledWith(
      '/Applications/WPXen.app/Contents/MacOS/WPXen',
      [staged.hostScriptPath, '--socket', staged.socketPath, '--version', '0.6.3'],
      expect.objectContaining({
        cwd: staged.versionDir,
        detached: true,
        stdio: 'ignore',
        env: expect.objectContaining({
          ELECTRON_RUN_AS_NODE: '1',
        }),
      })
    );
    // Script path is inside userData, never inside /Applications/WPXen.app.
    expect(staged.hostScriptPath.startsWith(tmp)).toBe(true);
  });
});

describe('Run Sessions in the Session Host behind a setting (#231)', () => {
  let home;
  let userData;
  let siteDir;
  let bin;
  let inAppPtys;
  let hostPtys;
  let store;
  let clock;
  let host;
  let sockPath;

  const site = () => ({ id: 'site-1', name: 'One', path: siteDir });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-231-home-'));
    userData = path.join(home, 'userData');
    siteDir = path.join(home, 'site');
    bin = path.join(home, 'bin');
    fs.mkdirSync(userData, { recursive: true });
    fs.mkdirSync(siteDir, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    for (const cmd of ['claude', 'grok']) {
      fs.writeFileSync(path.join(bin, cmd), '#!/bin/sh\ntrue\n');
      fs.chmodSync(path.join(bin, cmd), 0o755);
    }

    inAppPtys = [];
    hostPtys = [];
    store = fakeStore();
    clock = 1_700_000_000_000;
    host = null;
    sockPath = socketPathForVersion(userData, '0.6.3');

    agents.bindStore(store);
    agents.setKeepRunningOnQuit(false);
    agents.__setDeps({
      now: () => clock,
      spawnPty: fakePtyFactory(inAppPtys),
      shellEnv: () => ({ PATH: `${bin}:/usr/bin` }),
      userShell: () => '/bin/zsh',
      homedir: () => home,
      sitePhpBin: () => null,
      listProcesses: async () => [],
      readClaudeSessionId: () => null,
      userDataDir: () => userData,
      appVersion: () => '0.6.3',
      connectHost: null,
    });
  });

  afterEach(async () => {
    agents.shutdownAll({ forceStop: true });
    await agents.setKeepRunningOnQuit(false);
    agents.__setDeps({ connectHost: null });
    await host?.close?.();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('with the setting off, nothing about a host is started or copied, and behaviour matches #228', () => {
    const connectHostSpy = vi.fn();
    agents.__setDeps({ connectHost: connectHostSpy });
    agents.setKeepRunningOnQuit(false);

    const { sessionId } = agents.launch({ site: site(), agentId: 'claude' });
    expect(inAppPtys).toHaveLength(1);
    expect(connectHostSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(userData, WPXEN_SESSION_HOST_DIR))).toBe(false);

    // Quit and relaunch: Session is ended, as in #228.
    agents.shutdownAll();
    const restored = agents.restoreSessions({ projectIds: ['site-1'] });
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      sessionId,
      exited: true,
      state: 'exited',
    });
    expect(connectHostSpy).not.toHaveBeenCalled();
  });

  it('with the setting on: start a Session, quit WPXen, reopen it; the Session is live, accepts input and shows new output', async () => {
    host = createSessionHost({
      socketPath: sockPath,
      appVersion: '0.6.3',
      spawnPty: fakePtyFactory(hostPtys),
      now: () => clock,
    });
    await host.start();

    agents.__setDeps({
      connectHost: async () => {
        const client = createSessionHostClient({ socketPath: sockPath });
        const hello = await client.hello();
        return { client, hello, socketPath: sockPath };
      },
    });

    await agents.setKeepRunningOnQuit(true);

    const { ok, sessionId } = agents.launch({ site: site(), agentId: 'claude' });
    expect(ok).toBe(true);
    await until(() => hostPtys.length === 1);
    expect(inAppPtys).toHaveLength(0);

    hostPtys[0].emitData('initial-output ');
    await until(() => agents.getBuffer(sessionId).includes('initial-output'));

    // Quit WPXen: host Session keeps running (not killed).
    agents.shutdownAll();
    expect(hostPtys[0].kill).not.toHaveBeenCalled();

    // Output produced while WPXen is closed stays in the host.
    hostPtys[0].emitData('while-closed ');

    // Reopen WPXen: restoreSessions + reconnect to live host.
    agents.restoreSessions({ projectIds: ['site-1'] });
    await agents.initSessionHost({ projectIds: ['site-1'] });

    const rows = agents.listAllSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId,
      siteId: 'site-1',
      agentId: 'claude',
      exited: false,
    });

    // Attach a window, send input, and receive new output from the live Session.
    const sent = [];
    const fakeWin = {
      isDestroyed: () => false,
      webContents: {
        send: (channel, payload) => sent.push({ channel, payload }),
      },
    };
    agents.attach(sessionId, fakeWin);
    await until(() => sent.some((e) => e.channel === 'terminal-replay'));
    const replay = sent.find((e) => e.channel === 'terminal-replay');
    expect(replay.payload).toMatchObject({
      sessionId,
      data: 'initial-output while-closed ',
      exited: false,
    });

    agents.write(sessionId, 'status\r');
    await until(() => hostPtys[0].write.mock.calls.some((c) => c[0] === 'status\r'));

    hostPtys[0].emitData('live-again');
    await until(() =>
      sent.some((e) => e.channel === 'terminal-data' && e.payload.data === 'live-again')
    );
  });

  it('if the host fails to start, new Sessions open in the in-app provider and a visible notice says they will not survive quitting', async () => {
    agents.__setDeps({
      connectHost: async () => {
        throw new Error('socket bind EACCES');
      },
    });

    await agents.setKeepRunningOnQuit(true);

    const status = agents.getHostStatus();
    expect(status.fallback).toBe(true);
    expect(hostFallbackNotice(status, true)).toMatch(/survive quitting/i);

    const { ok, sessionId } = agents.launch({ site: site(), agentId: 'claude' });
    expect(ok).toBe(true);
    expect(inAppPtys).toHaveLength(1);
    expect(agents.getSession(sessionId).exited).toBe(false);
  });

  it('if the host dies while the app runs, its Sessions show as ended and can be resumed where the Agent supports it', async () => {
    host = createSessionHost({
      socketPath: sockPath,
      appVersion: '0.6.3',
      spawnPty: fakePtyFactory(hostPtys),
      now: () => clock,
    });
    await host.start();

    agents.__setDeps({
      listProcesses: async () => [{ pid: 6001, ppid: hostPtys[0]?.pid ?? 5010 }],
      readClaudeSessionId: (pid) => (pid === 6001 ? 'conv-host-crash-1' : null),
      connectHost: async () => {
        const client = createSessionHostClient({ socketPath: sockPath });
        const hello = await client.hello();
        return { client, hello, socketPath: sockPath };
      },
    });

    await agents.setKeepRunningOnQuit(true);
    const { sessionId } = agents.launch({ site: site(), agentId: 'claude' });
    await until(() => hostPtys.length === 1);

    // Give the session a pinned transcriptId so it can be resumed.
    const s = agents.getSession(sessionId);
    s.transcriptId = 'conv-host-crash-1';

    // Simulate the host process dying unexpectedly while WPXen is running.
    await host.close();
    host = null;

    await until(() => agents.getSession(sessionId)?.exited === true);
    const row = agents.listAllSessions().find((r) => r.sessionId === sessionId);
    expect(row.exited).toBe(true);

    // And the ended Session can be resumed (switching to in-app fallback if host is gone).
    agents.__setDeps({
      connectHost: async () => {
        throw new Error('host gone');
      },
    });
    const resumed = agents.resumeChatSession(sessionId, { site: site() });
    expect(resumed.ok).toBe(true);
    expect(agents.getSession(resumed.sessionId).transcriptId).toBe('conv-host-crash-1');
  });
});
