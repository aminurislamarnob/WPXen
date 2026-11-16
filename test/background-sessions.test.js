import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import agents from '../electron/services/agents.cjs';
import { createSessionHost } from '../electron/services/sessionHost.cjs';
import { createSessionHostClient } from '../electron/services/sessionHostClient.cjs';
import { socketPathForVersion } from '../electron/services/sessionHostManager.cjs';
import {
  backgroundSessionsLabel,
  shouldShowBackgroundSessionsRow,
} from '../src/lib/backgroundSessionsLabel.js';

const until = async (fn, timeout = 3000) => {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeout) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

function fakePtyFactory(ptys) {
  let nextPid = 9000;
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

describe('backgroundSessionsLabel pure helper (#236)', () => {
  it('formats zero, single-version, single-older-version, and multi-older-version labels', () => {
    expect(backgroundSessionsLabel({ totalRunning: 0, olderVersionCount: 0 })).toBe(
      'Background sessions: none running'
    );
    expect(backgroundSessionsLabel({ totalRunning: 2, olderVersionCount: 0 })).toBe(
      'Background sessions: 2 running'
    );
    expect(
      backgroundSessionsLabel({
        totalRunning: 3,
        olderVersionCount: 2,
        olderVersions: ['0.6.3'],
      })
    ).toBe('Background sessions: 3 running (2 from version 0.6.3)');
    expect(
      backgroundSessionsLabel({
        totalRunning: 4,
        olderVersionCount: 3,
        olderVersions: ['0.6.2', '0.6.3'],
      })
    ).toBe('Background sessions: 4 running (3 from older versions 0.6.2, 0.6.3)');
  });

  it('hides the row when keepRunningOnQuit is off and no host is running', () => {
    expect(
      shouldShowBackgroundSessionsRow({
        keepRunningOnQuit: false,
        connectedHostCount: 0,
        totalRunning: 0,
      })
    ).toBe(false);
    expect(
      shouldShowBackgroundSessionsRow({
        keepRunningOnQuit: true,
        connectedHostCount: 0,
        totalRunning: 0,
      })
    ).toBe(true);
    expect(
      shouldShowBackgroundSessionsRow({
        keepRunningOnQuit: false,
        connectedHostCount: 1,
        totalRunning: 2,
      })
    ).toBe(true);
  });
});

describe('stopAllBackgroundSessions (#236)', () => {
  let home;
  let userData;
  let siteDir;
  let bin;
  let store;
  let host;
  let ptys;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-236-'));
    userData = path.join(home, 'userData');
    siteDir = path.join(home, 'site');
    bin = path.join(home, 'bin');
    fs.mkdirSync(userData, { recursive: true });
    fs.mkdirSync(siteDir, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\ntrue\n');
    fs.chmodSync(path.join(bin, 'claude'), 0o755);

    store = fakeStore();
    ptys = [];
    host = null;

    agents.bindStore(store);
    agents.__setDeps({
      shellEnv: () => ({ PATH: `${bin}:/usr/bin` }),
      userShell: () => '/bin/zsh',
      homedir: () => home,
      sitePhpBin: () => null,
      userDataDir: () => userData,
      appVersion: () => '0.6.4',
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

  it('stops every background Session and leaves them listed as ended', async () => {
    const sockPath = socketPathForVersion(userData, '0.6.4');
    host = createSessionHost({
      socketPath: sockPath,
      appVersion: '0.6.4',
      spawnPty: fakePtyFactory(ptys),
    });
    await host.start();

    agents.__setDeps({
      connectHost: async (ver) => {
        const sp = socketPathForVersion(userData, ver);
        const client = createSessionHostClient({ socketPath: sp });
        const hello = await client.hello();
        return { client, hello, socketPath: sp };
      },
    });
    await agents.setKeepRunningOnQuit(true);

    const { sessionId } = agents.launch({
      site: { id: 'site-1', name: 'One', path: siteDir },
      agentId: 'claude',
    });
    await until(() => ptys.length === 1);
    expect(agents.getHostSummary()).toMatchObject({
      totalRunning: 1,
      olderVersionCount: 0,
    });

    agents.stopAllBackgroundSessions();
    await until(() => ptys[0].kill.mock.calls.length > 0);
    expect(ptys[0].kill).toHaveBeenCalledWith('SIGTERM');

    const rows = agents.listAllSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId,
      exited: true,
      state: 'exited',
    });
    expect(agents.getHostSummary().totalRunning).toBe(0);
  });
});
