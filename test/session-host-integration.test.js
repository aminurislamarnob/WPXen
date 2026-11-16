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

// A node-pty package laid out as npm installs it, with the macOS native files.
// CI runs on Linux, where node-pty ships no spawn-helper, so tests that need a
// complete package build one rather than use the installed copy.
function fakeNodePty(root) {
  const dir = path.join(root, 'node_modules', 'node-pty');
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'node-pty', main: './lib/index.js' })
  );
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), 'module.exports = {};');
  fs.mkdirSync(path.join(dir, 'build', 'Release'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'build', 'Release', 'pty.node'), 'native');
  fs.writeFileSync(path.join(dir, 'build', 'Release', 'spawn-helper'), '#!/bin/sh\n', {
    mode: 0o644,
  });
  return dir;
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
      nodePtyDir: fakeNodePty(path.join(tmp, 'pkg')),
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

  // The installed node-pty only has a spawn-helper on macOS, the one platform
  // WPXen ships for.
  it.runIf(process.platform === 'darwin')(
    'stages the installed node-pty package as the host needs it',
    () => {
      const staged = stageRuntimeFiles({ userDataDir: tmp, version: '0.6.3' });
      const release = path.join(
        staged.versionDir,
        'node_modules',
        'node-pty',
        'build',
        'Release'
      );
      expect(fs.existsSync(path.join(release, 'pty.node'))).toBe(true);
      expect(fs.statSync(path.join(release, 'spawn-helper')).mode & 0o111).not.toBe(0);
    }
  );

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
    const prebuildSubdir = path.join('prebuilds', `${process.platform}-${process.arch}`);
    fs.mkdirSync(path.join(unpackedPty, prebuildSubdir), { recursive: true });
    fs.writeFileSync(path.join(unpackedPty, prebuildSubdir, 'pty.node'), 'prebuild');
    fs.writeFileSync(
      path.join(unpackedPty, prebuildSubdir, 'spawn-helper'),
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
    const prebuildHelper = path.join(
      staged.versionDir,
      'node_modules',
      'node-pty',
      prebuildSubdir,
      'spawn-helper'
    );
    const prebuildNode = path.join(
      staged.versionDir,
      'node_modules',
      'node-pty',
      prebuildSubdir,
      'pty.node'
    );
    expect(fs.existsSync(helper)).toBe(true);
    expect(fs.statSync(helper).mode & 0o755).toBe(0o755);
    expect(fs.existsSync(prebuildHelper)).toBe(true);
    expect(fs.statSync(prebuildHelper).mode & 0o755).toBe(0o755);
    expect(fs.existsSync(prebuildNode)).toBe(true);
  });

  it('spawns the host detached under ELECTRON_RUN_AS_NODE=1 from the copied data folder, not the app bundle', () => {
    const staged = stageRuntimeFiles({
      userDataDir: tmp,
      version: '0.6.3',
      nodePtyDir: fakeNodePty(path.join(tmp, 'pkg')),
    });
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

  it('tracks done/needs-input/title/unread in the host across quit, clears unread on view, and fires no notification on reconnect (#232)', async () => {
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

    const alerts = [];
    const offAlert = agents.onAlert((a) => alerts.push(a));

    try {
      await agents.setKeepRunningOnQuit(true);
      const { sessionId } = agents.launch({ site: site(), agentId: 'claude' });
      await until(() => hostPtys.length === 1);

      // Quit WPXen while Session is running.
      agents.shutdownAll();

      // While closed, the agent works and finishes.
      hostPtys[0].emitData('\x1b]0;⠋ Refactoring\x07');
      hostPtys[0].emitData('\x1b]0;✳ Refactoring done\x07');

      // Reopen WPXen: reconnects with done + unread + title, and fires NO alert.
      agents.restoreSessions({ projectIds: ['site-1'] });
      await agents.initSessionHost();

      const row1 = agents.listAllSessions().find((r) => r.sessionId === sessionId);
      expect(row1).toMatchObject({
        sessionId,
        state: 'done',
        title: 'Refactoring done',
        unread: true,
        exited: false,
      });
      expect(alerts).toEqual([]);

      // Selecting the Session in the app clears unread in the host too.
      agents.setView({ focused: true, selected: sessionId });
      await until(
        () =>
          agents.listAllSessions().find((r) => r.sessionId === sessionId)?.unread ===
          false
      );

      // Quit and reopen again: unread stays cleared!
      agents.shutdownAll();
      agents.setView({ focused: false, selected: null });
      agents.restoreSessions({ projectIds: ['site-1'] });
      await agents.initSessionHost();

      const row2 = agents.listAllSessions().find((r) => r.sessionId === sessionId);
      expect(row2).toMatchObject({
        sessionId,
        state: 'done',
        title: 'Refactoring done',
        unread: false,
      });
      expect(alerts).toEqual([]);
    } finally {
      offAlert();
      agents.setView({ focused: false, selected: null });
    }
  });

  it('runs Floating Workspace terminals in the Session Host when setting is on, keeps them live across quit, and preserves all exclusions (#237)', async () => {
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

    const alerts = [];
    const offAlert = agents.onAlert((a) => alerts.push(a));

    try {
      await agents.setKeepRunningOnQuit(true);
      const res = agents.launchFloating({ cwd: siteDir });
      expect(res.ok).toBe(true);
      await until(() => hostPtys.length === 1);
      expect(inAppPtys).toHaveLength(0);

      // Exclusions: absent from Projects list, activeAgentCount, hasActiveSessions, and alerts.
      expect(agents.listAllSessions()).toEqual([]);
      expect(agents.activeAgentCount()).toBe(0);
      expect(agents.hasActiveSessions()).toBe(false);
      hostPtys[0].emitData('float-out\x07');
      await new Promise((r) => setTimeout(r, 30));
      expect(alerts).toEqual([]);

      // Quit and reopen: floating terminal is still live with its working folder.
      agents.shutdownAll();
      expect(hostPtys[0].kill).not.toHaveBeenCalled();

      agents.restoreSessions({ projectIds: ['site-1'] });
      await agents.initSessionHost();

      const floating = agents.listFloatingSessions();
      expect(floating).toHaveLength(1);
      expect(floating[0]).toMatchObject({
        sessionId: res.sessionId,
        cwd: siteDir,
        exited: false,
      });
      expect(agents.listAllSessions()).toEqual([]);
      expect(agents.activeAgentCount()).toBe(0);

      agents.write(res.sessionId, 'pwd\r');
      await until(() => hostPtys[0].write.mock.calls.some((c) => c[0] === 'pwd\r'));
    } finally {
      offAlert();
    }
  });

  it('does not duplicate output emitted while async Session Host attach is in flight', async () => {
    host = createSessionHost({
      socketPath: sockPath,
      appVersion: '0.6.3',
      spawnPty: fakePtyFactory(hostPtys),
      now: () => clock,
    });
    await host.start();

    let clientRef = null;
    agents.__setDeps({
      connectHost: async () => {
        const client = createSessionHostClient({ socketPath: sockPath });
        const origAttach = client.attach;
        client.attach = async (sid) => {
          // Simulate host output emitted on the socket while the attach RPC is in flight.
          hostPtys[0].emitData('in-flight\n');
          await new Promise((r) => setTimeout(r, 25));
          return origAttach(sid);
        };
        const hello = await client.hello();
        clientRef = client;
        return { client, hello, socketPath: sockPath };
      },
    });

    await agents.setKeepRunningOnQuit(true);
    const { sessionId } = agents.launch({ site: site(), agentId: 'claude' });
    await until(() => hostPtys.length === 1 && clientRef !== null);

    hostPtys[0].emitData('before\n');
    await new Promise((r) => setTimeout(r, 20));

    const sent = [];
    const fakeWin = {
      isDestroyed: () => false,
      webContents: {
        send: (channel, payload) => sent.push({ channel, payload }),
      },
    };

    agents.attach(sessionId, fakeWin);
    await until(() => sent.some((e) => e.channel === 'terminal-replay'));

    hostPtys[0].emitData('after\n');
    await until(() =>
      sent.some((e) => e.channel === 'terminal-data' && e.payload.data.includes('after'))
    );

    const replays = sent.filter((e) => e.channel === 'terminal-replay');
    const datas = sent.filter((e) => e.channel === 'terminal-data');
    expect(replays).toHaveLength(1);
    expect(replays[0].payload.data).toBe('before\nin-flight\n');
    expect(datas.map((d) => d.payload.data).join('')).toBe('after\n');
  });
});
