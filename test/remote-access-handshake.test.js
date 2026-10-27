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
import { stubbornWebSocket } from './helpers/stubbornWebSocket.js';

// Opening a device channel (#142). A connection counts as a device's only
// once it has proved itself on *this* socket, and stays one only while it
// answers. These tests record a real phone's conversation and replay it the
// way anyone on the path (Cloudflare carries every byte) could, then check
// the replay never authenticated — it is not connected-now, nothing it sent
// ran, and the socket is reaped. They stay protocol-agnostic on purpose:
// they only replay what the real client half sent.

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
// Every connected-now snapshot, so a test can see a device that was counted
// connected even for an instant.
let connectedSeen;

function wsUrl(port) {
  return `ws://127.0.0.1:${port}/wpxen-device`;
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-ra-revoke-'));
  fs.mkdirSync(path.join(home, 'code'));
  ptys = [];
  connectedSeen = [];
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
    handshakeTimeoutMs: 150,
    heartbeatMs: 40,
    sessions: {
      list: agents.listAllSessions,
      subscribe: agents.onSessionsChanged,
      markRead: (id, read) => agents.markRead(id, read),
      get: (id) => agents.getSession(id),
      projects: () => [{ id: 'shop', name: 'Shop', kind: 'site' }],
      subscribeOutput: (id, sinks) => agents.subscribeOutput(id, sinks),
      write: (id, data) => agents.write(id, data),
      resize: (id, cols, rows) => agents.resize(id, cols, rows),
    },
  });
  remoteAccess.onDevicesChanged((devices) =>
    connectedSeen.push(devices.filter((d) => d.connected).map((d) => d.id))
  );
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

// A `ws` client that records every text frame it sends, so the exact bytes a
// real phone put on the wire can be replayed.
function recordingWebSocket() {
  const sent = [];
  class Recording extends WebSocket {
    send(data, ...rest) {
      sent.push(String(data));
      return super.send(data, ...rest);
    }
  }
  return { Recording, sent };
}

async function rawSocket(port) {
  const ws = new WebSocket(wsUrl(port));
  await new Promise((resolve) => ws.on('open', resolve));
  const messages = [];
  ws.on('message', (data) => messages.push(data.toString()));
  const closed = new Promise((resolve) => ws.on('close', resolve));
  return { ws, messages, closed };
}

function writes() {
  return ptys[0].write.mock.calls.map(([data]) => data);
}

describe('a replayed conversation never authenticates', () => {
  it('is not counted connected, runs nothing, and is reaped', async () => {
    const { sessionId } = agents.launch({ site: site(), agentId: agents.SHELL_ID });
    const { port, keys, hostPublicKey, deviceId } = await pairKeys();
    const { Recording, sent } = recordingWebSocket();
    const client = createClient({
      url: wsUrl(port),
      WebSocket: Recording,
      keys,
      hostPublicKey,
      deviceId,
    });
    await client.connect();
    await client.request('terminal.write', { sessionId, data: 'typed once\n' });
    expect(writes()).toEqual(['typed once\n']);
    client.close();
    await waitFor(
      () => expect(remoteAccess.listDevices()[0].connected).toBe(false),
      'the phone never disconnected'
    );
    const recorded = [...sent];
    connectedSeen = [];

    // The whole conversation again, byte for byte, on a fresh socket.
    const replay = await rawSocket(port);
    for (const message of recorded) {
      replay.ws.send(message);
      await new Promise((r) => setTimeout(r, 20));
    }
    await waitFor(
      () => expect(replay.ws.readyState).toBe(WebSocket.CLOSED),
      'not reaped'
    );
    expect(connectedSeen.flat()).not.toContain(deviceId);
    expect(remoteAccess.listDevices()[0].connected).toBe(false);
    expect(writes()).toEqual(['typed once\n']);
  });

  it('a replayed opening alone holds nothing and is reaped unauthenticated', async () => {
    const { port, keys, hostPublicKey, deviceId } = await pairKeys();
    const { Recording, sent } = recordingWebSocket();
    const client = createClient({
      url: wsUrl(port),
      WebSocket: Recording,
      keys,
      hostPublicKey,
      deviceId,
    });
    await client.connect();
    client.close();
    await waitFor(
      () => expect(remoteAccess.listDevices()[0].connected).toBe(false),
      'the phone never disconnected'
    );
    connectedSeen = [];

    // Just the first message — what an idle replayer would park on a socket
    // to keep a device looking connected (and the Mac awake).
    const replay = await rawSocket(port);
    replay.ws.send(sent[0]);
    await replay.closed;
    expect(connectedSeen.flat()).not.toContain(deviceId);
  });

  it('a socket that says nothing is reaped too', async () => {
    const replay = await rawSocket(remoteAccess.getStatus().actualPort);
    await replay.closed;
    expect(replay.messages).toEqual([]);
  });
});

describe('heartbeat', () => {
  it('keeps a phone that answers pings', async () => {
    const { port, keys, hostPublicKey, deviceId } = await pairKeys();
    const client = createClient({
      url: wsUrl(port),
      WebSocket,
      keys,
      hostPublicKey,
      deviceId,
    });
    await client.connect();
    // Several beats: `ws` answers pings itself.
    await new Promise((r) => setTimeout(r, 300));
    expect(remoteAccess.listDevices()[0].connected).toBe(true);
    client.close();
  });

  it('cuts a phone that stops answering, freeing connected-now', async () => {
    const { port, keys, hostPublicKey, deviceId } = await pairKeys();
    // Authenticates properly, then never answers a ping: a phone that went
    // out of signal without a FIN.
    const client = createClient({
      url: wsUrl(port),
      WebSocket: stubborn.StubbornWebSocket,
      keys,
      hostPublicKey,
      deviceId,
    });
    await client.connect();
    expect(remoteAccess.listDevices()[0].connected).toBe(true);
    const socket = stubborn.sockets.at(-1);
    await waitFor(() => expect(socket.tcpClosed).toBe(true), 'silent phone kept');
    expect(remoteAccess.listDevices()[0].connected).toBe(false);
  });
});
