import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import agents from '../electron/services/agents.cjs';
import remoteAccess, {
  HOST_ID_KEY,
  DEVICE_KEY,
} from '../electron/services/remoteAccess.cjs';
import {
  PROTOCOL_VERSION,
  CLOSE_REVOKED,
  CLOSE_DISCONNECT_ALL,
  newKeyPair,
  parsePairingUrl,
  createPairRequest,
  openPairAccept,
  createClient,
  decodeBase64,
} from '../shared/remote-protocol/index.cjs';
import { stubbornWebSocket } from './helpers/stubbornWebSocket.js';

// Ending a phone's access must end it now (#143). `ws.close(code)` only asks:
// a peer that ignores the close frame keeps its socket for the close timeout
// (30 s in `ws`) and every sealed frame it sends meanwhile used to run —
// terminal.write included. These tests drive the real server with the real
// client half riding a socket that ignores close (helpers/stubbornWebSocket),
// which is what anyone holding a phone's keys can do.

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
      return key in data ? data[key] : fallback;
    },
    set(key, value) {
      data[key] = value;
    },
    delete(key) {
      delete data[key];
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
let stubborn;
// Live engine subscriptions the phone holds: +1 on subscribe, -1 when the
// server hands the unsubscribe back.
let liveSubs;

function wsUrl(port) {
  return `ws://127.0.0.1:${port}/wpxen-device`;
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-ra-revoke-'));
  fs.mkdirSync(path.join(home, 'code'));
  ptys = [];
  liveSubs = 0;
  stubborn = stubbornWebSocket();
  agents.__setDeps({
    spawnPty: () => {
      const p = fakePty();
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
    timers: { setTimeout, clearTimeout },
    sessions: {
      list: agents.listAllSessions,
      subscribe: agents.onSessionsChanged,
      markRead: (id, read) => agents.markRead(id, read),
      get: (id) => agents.getSession(id),
      projects: () => [{ id: 'shop', name: 'Shop', kind: 'site' }],
      subscribeOutput: (id, sinks) => {
        const off = agents.subscribeOutput(id, sinks);
        liveSubs += 1;
        let done = false;
        return () => {
          if (done) return;
          done = true;
          liveSubs -= 1;
          off();
        };
      },
      write: (id, data) => agents.write(id, data),
      resize: (id, cols, rows) => agents.resize(id, cols, rows),
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
  stubborn.destroyAll();
  remoteAccess.dispose();
  agents.stopAll();
  fs.rmSync(home, { recursive: true, force: true });
});

const site = () => ({ id: 'shop', name: 'Shop', path: path.join(home, 'code') });

async function waitFor(fn, message, timeout = 3000) {
  const start = Date.now();
  for (;;) {
    try {
      return fn();
    } catch {
      if (Date.now() - start > timeout) throw new Error(message);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

async function pairKeys() {
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
  return { port, keys, hostPublicKey, deviceId };
}

// A paired phone whose socket ignores close frames, attached to a live
// Session and proven able to type into it.
async function stubbornPhoneAtTerminal() {
  const { sessionId } = agents.launch({ site: site(), agentId: agents.SHELL_ID });
  const { port, keys, hostPublicKey, deviceId } = await pairKeys();
  const client = createClient({
    url: wsUrl(port),
    WebSocket: stubborn.StubbornWebSocket,
    keys,
    hostPublicKey,
    deviceId,
    requestTimeoutMs: 300,
  });
  await client.connect();
  await client.request('terminal.attach', { sessionId });
  await client.request('terminal.write', { sessionId, data: 'before\n' });
  expect(ptys[0].write).toHaveBeenCalledWith('before\n');
  return { client, sessionId, deviceId, socket: stubborn.sockets.at(-1) };
}

function writes() {
  return ptys[0].write.mock.calls.map(([data]) => data);
}

describe('ending access when the phone ignores the close frame', () => {
  it('revoke: the socket is cut at once and nothing it sends runs', async () => {
    const { client, sessionId, deviceId, socket } = await stubbornPhoneAtTerminal();
    await remoteAccess.revokeDevice(deviceId);
    client
      .request('terminal.write', { sessionId, data: 'after revoke\n' })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    expect(writes()).not.toContain('after revoke\n');
    await waitFor(() => expect(socket.tcpClosed).toBe(true), 'socket left open');
    // Best effort, before the cut: the phone can still tell it was removed.
    expect(socket.closeCodes).toContain(CLOSE_REVOKED);
  });

  it('disconnect all: the socket is cut at once and nothing it sends runs', async () => {
    const { client, sessionId, socket } = await stubbornPhoneAtTerminal();
    await remoteAccess.disconnectAll();
    client
      .request('terminal.write', { sessionId, data: 'after disconnect\n' })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    expect(writes()).not.toContain('after disconnect\n');
    await waitFor(() => expect(socket.tcpClosed).toBe(true), 'socket left open');
    expect(socket.closeCodes).toContain(CLOSE_DISCONNECT_ALL);
    expect(remoteAccess.listDevices()[0].connected).toBe(false);
  });

  it('Remote Access off: the socket is cut at once and nothing it sends runs', async () => {
    const { client, sessionId, socket } = await stubbornPhoneAtTerminal();
    remoteAccess.stop();
    client.request('terminal.write', { sessionId, data: 'after off\n' }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    expect(writes()).not.toContain('after off\n');
    await waitFor(() => expect(socket.tcpClosed).toBe(true), 'socket left open');
  });
});

describe('every frame re-checks its device', () => {
  it('drops a frame from a device whose record is gone, socket or no socket', async () => {
    const { sessionId } = agents.launch({ site: site(), agentId: agents.SHELL_ID });
    const { port, keys, hostPublicKey, deviceId } = await pairKeys();
    const client = createClient({
      url: wsUrl(port),
      WebSocket,
      keys,
      hostPublicKey,
      deviceId,
      requestTimeoutMs: 300,
    });
    const closed = new Promise((resolve) => client.onClose(resolve));
    await client.connect();
    await client.request('terminal.attach', { sessionId });
    // The record goes by some path other than revokeDevice (another window,
    // a store edit): the live socket must not outlive it.
    store.set(
      DEVICE_KEY,
      store.get(DEVICE_KEY, []).filter((d) => d.id !== deviceId)
    );
    await expect(
      client.request('terminal.write', { sessionId, data: 'orphaned\n' })
    ).rejects.toThrow();
    await closed;
    expect(writes()).not.toContain('orphaned\n');
  });
});

describe('ending access releases the terminal subscriptions', () => {
  // The close handler is what detaches a socket's terminals. Revoke and
  // disconnect-all used to delete the device's socket set before that
  // handler ran, so it found nothing and returned early: the engine kept
  // feeding a socket that no longer existed, once per revoke.
  async function phoneAtTerminal() {
    const { sessionId } = agents.launch({ site: site(), agentId: agents.SHELL_ID });
    const { port, keys, hostPublicKey, deviceId } = await pairKeys();
    const client = createClient({
      url: wsUrl(port),
      WebSocket,
      keys,
      hostPublicKey,
      deviceId,
    });
    await client.connect();
    await client.request('terminal.attach', { sessionId });
    expect(liveSubs).toBe(1);
    return { client, deviceId };
  }

  it('revoke unsubscribes the terminals', async () => {
    const { deviceId } = await phoneAtTerminal();
    await remoteAccess.revokeDevice(deviceId);
    await waitFor(() => expect(liveSubs).toBe(0), 'revoke leaked the subscription');
  });

  it('disconnect all unsubscribes the terminals', async () => {
    await phoneAtTerminal();
    await remoteAccess.disconnectAll();
    await waitFor(() => expect(liveSubs).toBe(0), 'disconnect leaked the subscription');
  });

  it('turning Remote Access off unsubscribes the terminals', async () => {
    await phoneAtTerminal();
    remoteAccess.stop();
    await waitFor(() => expect(liveSubs).toBe(0), 'stop leaked the subscription');
  });
});
