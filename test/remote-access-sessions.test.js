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

// Sessions over the encrypted channel (#145): the real server on 127.0.0.1:0,
// the real client half, and the real Session engine with a fake pty. Projects
// arrive through the injected sessions dep, like keepAwake.watchSessions.

const HOSTNAME = 'wpxen.example.com';
const PHONE_ROW_KEYS = [
  'agentId',
  'agentName',
  'changedAt',
  'exited',
  'exitCode',
  'hasTranscript',
  'label',
  'paneOf',
  'projectId',
  'sessionId',
  'startedAt',
  'state',
  'title',
  'unread',
];

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

function wsUrl(port) {
  return `ws://127.0.0.1:${port}/wpxen-device`;
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-ra-sessions-'));
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
  store = fakeStore({ [HOST_ID_KEY]: 'test-host-id' });
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
  remoteAccess.dispose();
  agents.stopAll();
  fs.rmSync(home, { recursive: true, force: true });
});

const site = () => ({ id: 'shop', name: 'Shop', path: path.join(home, 'code') });

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
  const events = [];
  client.subscribe('sessions.changed', (payload) => events.push(payload));
  await client.connect();
  await client.request('ping');
  return { client, events };
}

describe('sessions over the channel', () => {
  it('lists projects in sidebar order', async () => {
    const { client } = await pairedPhone();
    expect(await client.request('projects.list')).toEqual({
      projects: [{ id: 'shop', name: 'Shop', kind: 'site' }],
    });
    client.close();
  });

  it('lists phone-safe rows with exactly the listed fields', async () => {
    const { sessionId } = agents.launch({ site: site(), agentId: agents.SHELL_ID });
    const { client } = await pairedPhone();
    const { sessions } = await client.request('sessions.list');
    const row = sessions.find((s) => s.sessionId === sessionId);
    expect(Object.keys(row).sort()).toEqual([...PHONE_ROW_KEYS].sort());
    expect(row).toMatchObject({
      projectId: 'shop',
      agentId: agents.SHELL_ID,
      exited: false,
      unread: false,
      hasTranscript: false,
    });
    expect(JSON.stringify(row)).not.toContain(home);
    client.close();
  });

  it('pushes sessions.changed live as Sessions start and exit', async () => {
    const { client, events } = await pairedPhone();
    const { sessionId } = agents.launch({ site: site(), agentId: agents.SHELL_ID });
    const seen = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('no sessions.changed arrived')),
        3000
      );
      const check = () => {
        const match = events.find((e) =>
          e.sessions.some((s) => s.sessionId === sessionId)
        );
        if (match) {
          clearTimeout(timer);
          resolve(match);
        } else setTimeout(check, 25);
      };
      check();
    });
    expect(
      seen.sessions.some((s) => s.sessionId === sessionId && s.exited === false)
    ).toBe(true);
    ptys[0].emitExit(0);
    const exited = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no exit push arrived')), 3000);
      const check = () => {
        const match = events.find((e) =>
          e.sessions.some((s) => s.sessionId === sessionId && s.exited === true)
        );
        if (match) {
          clearTimeout(timer);
          resolve(match);
        } else setTimeout(check, 25);
      };
      check();
    });
    expect(exited.sessions.find((s) => s.sessionId === sessionId)).toMatchObject({
      exited: true,
      exitCode: 0,
    });
    client.close();
  });

  it('coalesces a burst of engine changes into few pushes', async () => {
    const { client, events } = await pairedPhone();
    agents.launch({ site: site(), agentId: agents.SHELL_ID });
    events.length = 0;
    for (let i = 0; i < 10; i++) ptys[0].emitData(`chunk ${i}\n`);
    await new Promise((r) => setTimeout(r, 800));
    expect(events.length).toBeLessThanOrEqual(3);
    expect(events.length).toBeGreaterThanOrEqual(1);
    client.close();
  });

  it('marking read on the phone clears unread on the desktop, and vice versa', async () => {
    const { sessionId } = agents.launch({ site: site(), agentId: agents.SHELL_ID });
    agents.markRead(sessionId, false);
    const { client, events } = await pairedPhone();
    let { sessions } = await client.request('sessions.list');
    expect(sessions.find((s) => s.sessionId === sessionId).unread).toBe(true);

    expect(await client.request('sessions.markRead', { sessionId })).toEqual({
      ok: true,
    });
    ({ sessions } = await client.request('sessions.list'));
    expect(sessions.find((s) => s.sessionId === sessionId).unread).toBe(false);

    agents.markRead(sessionId, false);
    const pushed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no unread push arrived')), 3000);
      const check = () => {
        const match = events.find((e) =>
          e.sessions.some((s) => s.sessionId === sessionId && s.unread === true)
        );
        if (match) {
          clearTimeout(timer);
          resolve(match);
        } else setTimeout(check, 25);
      };
      check();
    });
    expect(pushed.sessions.find((s) => s.sessionId === sessionId).unread).toBe(true);
    client.close();
  });

  it('never lists floating Sessions', async () => {
    agents.launchFloating({ cwd: home });
    const { client } = await pairedPhone();
    const { sessions } = await client.request('sessions.list');
    expect(sessions).toEqual([]);
    client.close();
  });

  it('rejects unknown ops and unknown sessions on markRead', async () => {
    const { client } = await pairedPhone();
    await expect(client.request('sessions.teleport')).rejects.toThrow('op_not_allowed');
    await expect(client.request('sessions.markRead', {})).rejects.toThrow();
    await expect(
      client.request('sessions.markRead', { sessionId: 'nope' })
    ).rejects.toThrow();
    client.close();
  });
});
