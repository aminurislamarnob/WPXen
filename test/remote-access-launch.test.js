import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import agents from '../electron/services/agents.cjs';
import remoteAccess, { HOST_ID_KEY } from '../electron/services/remoteAccess.cjs';
import {
  PROTOCOL_VERSION,
  newKeyPair,
  parsePairingUrl,
  createPairRequest,
  openPairAccept,
  createClient,
  decodeBase64,
} from '../shared/remote-protocol/index.cjs';

// Launch and stop Sessions from the phone (#148): the real server on
// 127.0.0.1:0, the real client half, and the real Session engine with a fake
// pty. Phone and desktop launches share agents.launchForProject, so the two
// paths can never drift.

const HOSTNAME = 'wpxen.example.com';

function fakePty() {
  const handlers = { data: [], exit: [] };
  return {
    onData: (cb) => handlers.data.push(cb),
    onExit: (cb) => handlers.exit.push(cb),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    emitData: (d) => handlers.data.forEach((cb) => cb(d)),
    emitExit: (code) => handlers.exit.forEach((cb) => cb({ exitCode: code })),
  };
}

function fakeStore(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    get(key, fallback) {
      const value = key.split('.').reduce((obj, k) => obj?.[k], data);
      return value !== undefined ? value : fallback;
    },
    set(key, value) {
      const keys = key.split('.');
      let obj = data;
      for (let i = 0; i < keys.length - 1; i++) {
        if (typeof obj[keys[i]] !== 'object' || obj[keys[i]] === null) obj[keys[i]] = {};
        obj = obj[keys[i]];
      }
      obj[keys[keys.length - 1]] = value;
    },
    delete(key) {
      const keys = key.split('.');
      const parent = keys.slice(0, -1).reduce((obj, k) => obj?.[k], data);
      if (parent) delete parent[keys[keys.length - 1]];
    },
  };
}

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (cipher) =>
      Buffer.from(cipher.toString('utf8').replace(/^enc:/, ''), 'utf8'),
  };
}

let home;
let ptys;
let store;
let addedToProjects;

function wsUrl(port) {
  return `ws://127.0.0.1:${port}/wpxen-device`;
}

// A Site record with one saved Launch Target, as the desktop stores it.
function siteRecord() {
  return {
    id: 'shop',
    name: 'Shop',
    path: path.join(home, 'code'),
    launchTargets: [
      {
        id: 'plugin',
        label: 'Plugin',
        cwd: 'wp-content/plugins/foo',
        args: '--target-flag',
      },
    ],
  };
}

const findProject = (id) => (id === 'shop' ? siteRecord() : null);
const getPresetArgs = (agentId) => store.get('agentPresets', {})[agentId]?.args || '';

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-ra-launch-'));
  fs.mkdirSync(path.join(home, 'code'));
  fs.mkdirSync(path.join(home, 'code', 'wp-content', 'plugins', 'foo'), {
    recursive: true,
  });
  ptys = [];
  addedToProjects = [];
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
  // `sh` is on every PATH, so this custom agent is always detected.
  agents.setConfig({ custom: [{ id: 'fake', name: 'Fake', cmd: 'sh --agent' }] });
  store = fakeStore({
    [HOST_ID_KEY]: 'test-host-id',
    agentPresets: { fake: { args: '--preset-flag' } },
  });
  remoteAccess.__setDeps({
    store,
    safeStorage: fakeSafeStorage(),
    randomId: () => 'test-id',
    now: () => Date.now(),
    pairTimeoutMs: 500,
    promptPairing: async () => 'allow',
    onPaired: () => {},
    getRemoteConfig: () => ({ enabled: true, port: 6780, hostname: HOSTNAME }),
    sessions: {
      list: agents.listAllSessions,
      subscribe: agents.onSessionsChanged,
      markRead: (id, read) => agents.markRead(id, read),
      get: (id) => agents.getSession(id),
      projects: () => [{ id: 'shop', name: 'Shop', kind: 'site' }],
      subscribeOutput: (id, sinks) => agents.subscribeOutput(id, sinks),
      write: (id, data) => agents.write(id, data),
      resize: (id, cols, rows) => agents.resize(id, cols, rows),
      listAgents: () => agents.listAgents(),
      shellId: agents.SHELL_ID,
      targets: (projectId) => {
        const site = findProject(projectId);
        if (!site) throw new Error('Project not found');
        return (site.launchTargets || []).map((t) => ({ id: t.id, label: t.label }));
      },
      launch: (args) =>
        agents.launchForProject(
          { findProject, getPresetArgs, addToProjects: (id) => addedToProjects.push(id) },
          args
        ),
      stop: (id) => {
        if (!agents.getSession(id)) throw new Error('Unknown session.');
        agents.stop(id);
        return { ok: true };
      },
    },
  });
  remoteAccess.start({ port: 0 });
  const start = Date.now();
  while (remoteAccess.getStatus().state !== 'listening') {
    if (Date.now() - start > 5000) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 10));
  }
});

afterEach(() => {
  agents.setConfig({});
  remoteAccess.dispose();
  agents.stopAll();
  fs.rmSync(home, { recursive: true, force: true });
});

async function pairedPhone() {
  const port = remoteAccess.getStatus().actualPort;
  const keys = newKeyPair();
  const offer = await remoteAccess.pairingOffer({ hostname: HOSTNAME });
  const parsed = parsePairingUrl(offer.url);
  const hostPublicKey = decodeBase64(parsed.hostPublicKeyB64);
  const { message } = createPairRequest({
    secret: parsed.secret,
    deviceName: 'Phone',
    platform: 'ios',
    keys,
    hostPublicKey,
    version: PROTOCOL_VERSION,
  });
  const socket = new WebSocket(wsUrl(port));
  await new Promise((resolve, reject) => {
    socket.on('open', resolve);
    socket.on('error', reject);
  });
  const reply = await new Promise((resolve) => {
    socket.on('message', (data) => resolve(JSON.parse(data.toString())));
    socket.send(JSON.stringify(message));
  });
  const { deviceId } = openPairAccept({ message: reply, keys, hostPublicKey });
  socket.close();
  const client = createClient({
    url: wsUrl(port),
    WebSocket,
    keys,
    hostPublicKey,
    deviceId,
  });
  await client.connect();
  await client.request('ping');
  return { client };
}

// Settle the shell and read the typed agent command, like the floating tests.
async function settledWrite(pty) {
  vi.useFakeTimers();
  try {
    pty.emitData('% ');
    await vi.advanceTimersByTimeAsync(1300);
  } finally {
    vi.useRealTimers();
  }
  return pty.write.mock.calls.map((call) => call[0]).join('');
}

describe('launch from the phone', () => {
  it('lists only installed AI-provider Agents, as id and name', async () => {
    const { client } = await pairedPhone();
    const { agents: list } = await client.request('agents.list');
    expect(list.length).toBeGreaterThanOrEqual(1);
    for (const agent of list) {
      expect(Object.keys(agent).sort()).toEqual(['id', 'name']);
    }
    expect(list.some((a) => a.id === agents.SHELL_ID)).toBe(false);
    expect(list.some((a) => a.id === 'fake')).toBe(true);
    client.close();
  });

  it('lists a Project targets as ids and labels, with no paths', async () => {
    const { client } = await pairedPhone();
    expect(await client.request('projects.launchTargets', { projectId: 'shop' })).toEqual(
      {
        targets: [{ id: 'plugin', label: 'Plugin' }],
      }
    );
    await expect(
      client.request('projects.launchTargets', { projectId: 'nope' })
    ).rejects.toThrow('Project not found');
    client.close();
  });

  it('launches with the same command line and cwd as the desktop path', async () => {
    const { client } = await pairedPhone();
    const launched = await client.request('sessions.launch', {
      projectId: 'shop',
      agentId: 'fake',
      targetId: 'plugin',
    });
    expect(typeof launched.sessionId).toBe('string');
    // The Target's directory, resolved against the webroot.
    expect(ptys[0].spawnedWith.opts.cwd).toBe(
      path.join(home, 'code', 'wp-content', 'plugins', 'foo')
    );
    // The Target's flags win over the Launch Preset, exactly as on desktop.
    const phoneTyped = await settledWrite(ptys[0]);
    expect(phoneTyped).toContain('--target-flag');

    // The desktop menu runs the same function with the same inputs.
    const desktop = agents.launchForProject(
      { findProject, getPresetArgs, addToProjects: () => {} },
      { projectId: 'shop', agentId: 'fake', targetId: 'plugin' }
    );
    expect(desktop.ok).toBe(true);
    expect(ptys[1].spawnedWith.opts.cwd).toBe(ptys[0].spawnedWith.opts.cwd);
    expect(await settledWrite(ptys[1])).toBe(phoneTyped);
    client.close();
  });

  it('applies the Launch Preset when no Target is picked', async () => {
    const { client } = await pairedPhone();
    await client.request('sessions.launch', { projectId: 'shop', agentId: 'fake' });
    expect(ptys[0].spawnedWith.opts.cwd).toBe(path.join(home, 'code'));
    expect(await settledWrite(ptys[0])).toContain('--preset-flag');
    client.close();
  });

  it('fails distinctly without spawning for bad inputs', async () => {
    const { client } = await pairedPhone();
    await expect(
      client.request('sessions.launch', { projectId: 'shop', agentId: 'ghost' })
    ).rejects.toThrow('Unknown agent');
    await expect(
      client.request('sessions.launch', { projectId: 'shop', agentId: agents.SHELL_ID })
    ).rejects.toThrow(/shell/i);
    await expect(
      client.request('sessions.launch', { projectId: 'nope', agentId: 'fake' })
    ).rejects.toThrow('Project not found');
    await expect(
      client.request('sessions.launch', {
        projectId: 'shop',
        agentId: 'fake',
        targetId: 'nope',
      })
    ).rejects.toThrow('Launch target not found');
    expect(ptys).toHaveLength(0);
    expect(addedToProjects).toEqual([]);
    client.close();
  });

  it('joins the working set and shows in the desktop sidebar feed', async () => {
    const { client } = await pairedPhone();
    const { sessionId } = await client.request('sessions.launch', {
      projectId: 'shop',
      agentId: 'fake',
    });
    expect(addedToProjects).toEqual(['shop']);
    expect(agents.listAllSessions().some((s) => s.sessionId === sessionId)).toBe(true);
    client.close();
  });
});

describe('stop from the phone', () => {
  it('stops the Session everywhere; unknown ids fail', async () => {
    const { client } = await pairedPhone();
    const { sessionId } = await client.request('sessions.launch', {
      projectId: 'shop',
      agentId: 'fake',
    });
    const events = [];
    client.subscribe('sessions.changed', (payload) => events.push(payload));

    expect(await client.request('sessions.stop', { sessionId })).toEqual({ ok: true });
    expect(agents.listAllSessions().some((s) => s.sessionId === sessionId)).toBe(false);
    const { sessions } = await client.request('sessions.list');
    expect(sessions.some((s) => s.sessionId === sessionId)).toBe(false);
    await expect(
      client.request('sessions.stop', { sessionId: 'nope' })
    ).rejects.toThrow();
    client.close();
  });
});
