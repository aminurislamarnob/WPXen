import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import agents from '../electron/services/agents.cjs';
import { createSessionHost } from '../electron/services/sessionHost.cjs';
import { createSessionHostClient } from '../electron/services/sessionHostClient.cjs';
import {
  WPXEN_SESSION_HOST_DIR,
  parseHostSocketName,
  planHostDiscovery,
  discoverHosts,
  socketPathForVersion,
  runtimeDirForVersion,
} from '../electron/services/sessionHostManager.cjs';

const until = async (fn, timeout = 3000) => {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeout) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

function fakePtyFactory(ptys) {
  let nextPid = 8000;
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

describe('planHostDiscovery pure planner (#235)', () => {
  it('parses versioned socket filenames and ignores unrelated files', () => {
    expect(parseHostSocketName('wpxen-host-0.6.2.sock')).toBe('0.6.2');
    expect(parseHostSocketName('wpxen-host-0.7.0-beta.1.sock')).toBe('0.7.0-beta.1');
    expect(parseHostSocketName('wpxen-repair.sock')).toBeNull();
    expect(parseHostSocketName('other.txt')).toBeNull();
  });

  it('connects to live hosts, removes dead sockets, and deletes only unused version folders', () => {
    const plan = planHostDiscovery({
      socketNames: [
        'wpxen-host-0.6.2.sock',
        'wpxen-host-0.6.1.sock',
        'wpxen-repair.sock',
      ],
      versionDirNames: ['0.6.0', '0.6.1', '0.6.2'],
      probeResults: {
        'wpxen-host-0.6.2.sock': { reachable: true, version: '0.6.2' },
        'wpxen-host-0.6.1.sock': { reachable: false },
      },
    });

    expect(plan).toEqual({
      connectSockets: ['wpxen-host-0.6.2.sock'],
      deadSockets: ['wpxen-host-0.6.1.sock'],
      liveVersions: ['0.6.2'],
      staleVersionDirs: ['0.6.0', '0.6.1'],
    });
  });
});

describe('multi-version Session Hosts across updates (#235)', () => {
  let home;
  let userData;
  let siteDir;
  let bin;
  let store;
  let clock;
  let oldPtys;
  let newPtys;
  let oldHost;
  let newHost;

  const site = () => ({ id: 'site-1', name: 'One', path: siteDir });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-235-'));
    userData = path.join(home, 'userData');
    siteDir = path.join(home, 'site');
    bin = path.join(home, 'bin');
    fs.mkdirSync(userData, { recursive: true });
    fs.mkdirSync(siteDir, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\ntrue\n');
    fs.chmodSync(path.join(bin, 'claude'), 0o755);

    store = fakeStore();
    clock = 1_700_000_000_000;
    oldPtys = [];
    newPtys = [];
    oldHost = null;
    newHost = null;

    agents.bindStore(store);
    agents.__setDeps({
      now: () => clock,
      shellEnv: () => ({ PATH: `${bin}:/usr/bin` }),
      userShell: () => '/bin/zsh',
      homedir: () => home,
      sitePhpBin: () => null,
      userDataDir: () => userData,
      appVersion: () => '0.6.2',
      connectHost: null,
      discoverHosts: null,
    });
  });

  afterEach(async () => {
    agents.shutdownAll({ forceStop: true });
    await agents.setKeepRunningOnQuit(false);
    agents.__setDeps({ connectHost: null, discoverHosts: null });
    await oldHost?.close?.();
    await newHost?.close?.();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('discovers live hosts, cleans up dead sockets and unused version folders without killing anything', async () => {
    const liveSock = socketPathForVersion(userData, '0.6.2');
    const deadSock = socketPathForVersion(userData, '0.6.1');
    const liveDir = runtimeDirForVersion(userData, '0.6.2');
    const deadDir = runtimeDirForVersion(userData, '0.6.1');
    fs.mkdirSync(liveDir, { recursive: true });
    fs.mkdirSync(deadDir, { recursive: true });
    fs.writeFileSync(deadSock, ''); // stale dead socket file

    oldHost = createSessionHost({
      socketPath: liveSock,
      appVersion: '0.6.2',
      spawnPty: fakePtyFactory(oldPtys),
      now: () => clock,
    });
    await oldHost.start();

    const found = await discoverHosts({ userDataDir: userData });
    expect(found.hosts).toHaveLength(1);
    expect(found.hosts[0]).toMatchObject({
      version: '0.6.2',
      socketPath: liveSock,
    });
    expect(found.removedSockets).toEqual(['wpxen-host-0.6.1.sock']);
    expect(found.removedVersionDirs).toEqual(['0.6.1']);
    expect(fs.existsSync(deadSock)).toBe(false);
    expect(fs.existsSync(deadDir)).toBe(false);
    expect(fs.existsSync(liveDir)).toBe(true);

    for (const h of found.hosts) await h.client.close();
  });

  it('keeps old-version Sessions live after update and starts new Sessions in the new version host', async () => {
    const oldSock = socketPathForVersion(userData, '0.6.2');
    const newSock = socketPathForVersion(userData, '0.6.3');
    fs.mkdirSync(path.join(userData, WPXEN_SESSION_HOST_DIR, '0.6.2'), {
      recursive: true,
    });

    oldHost = createSessionHost({
      socketPath: oldSock,
      appVersion: '0.6.2',
      spawnPty: fakePtyFactory(oldPtys),
      now: () => clock,
    });
    await oldHost.start();

    newHost = createSessionHost({
      socketPath: newSock,
      appVersion: '0.6.3',
      spawnPty: fakePtyFactory(newPtys),
      now: () => clock,
    });
    await newHost.start();

    // 1. Running app v0.6.2 starts a Session, then quits.
    agents.__setDeps({
      appVersion: () => '0.6.2',
      connectHost: async (version) => {
        const sp = socketPathForVersion(userData, version);
        const client = createSessionHostClient({ socketPath: sp });
        const hello = await client.hello();
        return { client, hello, socketPath: sp, version };
      },
    });
    await agents.setKeepRunningOnQuit(true);
    const oldLaunch = agents.launch({ site: site(), agentId: 'claude' });
    await until(() => oldPtys.length === 1);
    agents.shutdownAll();

    // 2. User updates to v0.6.3 and launches the new app.
    agents.__setDeps({
      appVersion: () => '0.6.3',
    });
    agents.restoreSessions({ projectIds: ['site-1'] });
    await agents.initSessionHost();

    // Old Session is live on v0.6.2 host and accepts input.
    const rowsBefore = agents.listAllSessions();
    expect(rowsBefore).toHaveLength(1);
    expect(rowsBefore[0]).toMatchObject({
      sessionId: oldLaunch.sessionId,
      exited: false,
      hostVersion: '0.6.2',
    });

    agents.write(oldLaunch.sessionId, 'echo from-new-app\r');
    await until(() =>
      oldPtys[0].write.mock.calls.some((c) => c[0] === 'echo from-new-app\r')
    );

    // New Session starts in the v0.6.3 host!
    const newLaunch = agents.launch({ site: site(), agentId: 'claude' });
    await until(() => newPtys.length === 1);

    const rowsAfter = agents.listAllSessions();
    expect(rowsAfter).toHaveLength(2);
    expect(rowsAfter.find((r) => r.sessionId === newLaunch.sessionId)).toMatchObject({
      exited: false,
      hostVersion: '0.6.3',
    });
  });

  it('speaks to an older host using only protocol features announced in hello', async () => {
    // Simulate a legacy v1 host that only knows the original #230 commands (no mark-read).
    const legacySock = path.join(userData, 'wpxen-host-0.6.0.sock');
    const receivedTypes = [];
    const srv = net.createServer((conn) => {
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const msg = JSON.parse(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
          receivedTypes.push(msg.type);
          if (msg.type === 'hello') {
            conn.write(
              JSON.stringify({
                v: 1,
                id: msg.id,
                ok: true,
                appVersion: '0.6.0',
                protocolVersion: 1,
              }) + '\n'
            );
          } else {
            conn.write(JSON.stringify({ v: 1, id: msg.id, ok: true }) + '\n');
          }
        }
      });
    });
    await new Promise((r) => srv.listen(legacySock, r));

    const client = createSessionHostClient({ socketPath: legacySock });
    try {
      const hello = await client.hello();
      expect(hello.capabilities).toBeUndefined();
      // markRead must be a safe no-op when host did not announce 'mark-read'.
      await client.markRead('s-1', true);
      expect(receivedTypes).toEqual(['hello']);
    } finally {
      await client.close();
      await new Promise((r) => srv.close(r));
    }
  });
});
