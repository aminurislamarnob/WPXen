import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import remoteAccess, { HOST_ID_KEY } from '../electron/services/remoteAccess.cjs';
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

// Device management (#143) through the pairing ticket's seam: the real
// server on 127.0.0.1:0 driven by the real client half, with prompt, clock,
// ids and storage swapped through `__setDeps`.

const HOSTNAME = 'wpxen.example.com';

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

let store;
let now;

function wsUrl(port) {
  return `ws://127.0.0.1:${port}/wpxen-device`;
}

async function pairDevice({ port, name = 'My iPhone', platform = 'ios' }) {
  const keys = newKeyPair();
  const offer = await remoteAccess.pairingOffer({ hostname: HOSTNAME });
  const parsed = parsePairingUrl(offer.url);
  const hostPublicKey = decodeBase64(parsed.hostPublicKeyB64);
  const { message } = createPairRequest({
    secret: parsed.secret,
    deviceName: name,
    platform,
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
  if (reply.type !== 'pair-accept') throw new Error(`pairing failed: ${reply.reason}`);
  const { deviceId } = openPairAccept({ message: reply, keys, hostPublicKey });
  return { deviceId, keys, hostPublicKey, socket };
}

beforeEach(async () => {
  store = fakeStore({ [HOST_ID_KEY]: 'test-host-id' });
  now = Date.now();
  remoteAccess.__setDeps({
    store,
    safeStorage: fakeSafeStorage(),
    randomId: () => 'test-id',
    now: () => now,
    pairTimeoutMs: 500,
    promptPairing: async () => 'allow',
    onPaired: () => {},
    getRemoteConfig: () => ({ enabled: true, port: 6780, hostname: HOSTNAME }),
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
});

describe('device list', () => {
  it('shows name, platform, paired date, last seen and connected-now, live', async () => {
    const port = remoteAccess.getStatus().actualPort;
    const seen = [];
    const off = remoteAccess.onDevicesChanged((devices) => seen.push(devices));

    expect(remoteAccess.listDevices()).toEqual([]);
    const { deviceId, socket } = await pairDevice({ port });
    let list = remoteAccess.listDevices();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: deviceId,
      name: 'My iPhone',
      platform: 'ios',
      // The pairing socket stays up as the device's channel.
      connected: true,
    });
    expect(typeof list[0].pairedAt).toBe('number');
    expect(typeof list[0].lastSeen).toBe('number');
    expect(seen.length).toBeGreaterThan(0);
    socket.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(remoteAccess.listDevices()[0].connected).toBe(false);
    off();
  });

  it('marks a live socket connected and unmarks it on disconnect', async () => {
    const port = remoteAccess.getStatus().actualPort;
    const keys = newKeyPair();
    // Pair with known keys so the same identity can open a channel.
    const offer = await remoteAccess.pairingOffer({ hostname: HOSTNAME });
    const parsed = parsePairingUrl(offer.url);
    const hostPublicKey = decodeBase64(parsed.hostPublicKeyB64);
    const { message } = createPairRequest({
      secret: parsed.secret,
      deviceName: 'Tablet',
      platform: 'android',
      keys,
      hostPublicKey,
      version: PROTOCOL_VERSION,
    });
    const socket = new WebSocket(wsUrl(port));
    await new Promise((resolve) => socket.on('open', resolve));
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
    expect(remoteAccess.listDevices().find((d) => d.id === deviceId).connected).toBe(
      true
    );
    client.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(remoteAccess.listDevices().find((d) => d.id === deviceId).connected).toBe(
      false
    );
  });
});

describe('rename', () => {
  it('persists and shows immediately; rejects bad names and unknown ids', async () => {
    const port = remoteAccess.getStatus().actualPort;
    const { deviceId, socket } = await pairDevice({ port });
    const seen = [];
    const off = remoteAccess.onDevicesChanged((devices) => seen.push(devices));

    await remoteAccess.renameDevice(deviceId, '  Work Phone  ');
    expect(remoteAccess.listDevices()[0].name).toBe('Work Phone');
    expect(seen.at(-1)[0].name).toBe('Work Phone');

    await expect(remoteAccess.renameDevice(deviceId, '  ')).rejects.toThrow();
    await expect(remoteAccess.renameDevice('no-such-id', 'X')).rejects.toThrow();
    socket.close();
    off();
  });
});

describe('revoke', () => {
  it('deletes the record, closes the live socket with the revoked code, and rejects the next connect', async () => {
    const port = remoteAccess.getStatus().actualPort;
    const keys = newKeyPair();
    const offer = await remoteAccess.pairingOffer({ hostname: HOSTNAME });
    const parsed = parsePairingUrl(offer.url);
    const hostPublicKey = decodeBase64(parsed.hostPublicKeyB64);
    const { message } = createPairRequest({
      secret: parsed.secret,
      deviceName: 'Old Phone',
      platform: 'ios',
      keys,
      hostPublicKey,
      version: PROTOCOL_VERSION,
    });
    const socket = new WebSocket(wsUrl(port));
    await new Promise((resolve) => socket.on('open', resolve));
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
    const closeReason = new Promise((resolve) => client.onClose(resolve));
    await client.connect();
    await client.request('ping');

    await remoteAccess.revokeDevice(deviceId);
    expect(remoteAccess.listDevices()).toEqual([]);
    await expect(closeReason).resolves.toBe('revoked');

    // The next connection fails the way an unknown device does: closed, no reply.
    const retry = createClient({
      url: wsUrl(port),
      WebSocket,
      keys,
      hostPublicKey,
      deviceId,
    });
    const retryClosed = new Promise((resolve) => retry.onClose(resolve));
    await retry.connect();
    let answered = false;
    try {
      await retry.request('ping', { timeoutMs: 500 });
      answered = true;
    } catch {
      // Rejected, as it must be: the socket is closed, not answered.
    }
    expect(answered).toBe(false);
    await expect(retryClosed).resolves.toBe('closed');
    retry.close();
  });

  it('rejects an unknown id', async () => {
    await expect(remoteAccess.revokeDevice('no-such-id')).rejects.toThrow();
  });
});

describe('disconnect all', () => {
  it('closes every socket with the disconnect code and keeps the records', async () => {
    const port = remoteAccess.getStatus().actualPort;
    const first = await pairDevice({ port, name: 'One' });
    const second = await pairDevice({ port, name: 'Two' });

    const openOne = async ({ deviceId, keys, hostPublicKey }) => {
      const client = createClient({
        url: wsUrl(port),
        WebSocket,
        keys,
        hostPublicKey,
        deviceId,
      });
      const closed = new Promise((resolve) => client.onClose(resolve));
      await client.connect();
      await client.request('ping');
      return { client, closed };
    };
    // pairDevice closes its pairing socket; reopen channels on the same
    // identities (counters are per connection, so this is a fresh start).
    const c1 = await openOne(first);
    const c2 = await openOne(second);

    await remoteAccess.disconnectAll();
    await expect(c1.closed).resolves.toBe('closed');
    await expect(c2.closed).resolves.toBe('closed');
    expect(remoteAccess.listDevices()).toHaveLength(2);
    c1.client.close();
    c2.client.close();
  });
});

describe('last seen', () => {
  it('writes on connect and at most once a minute while connected', async () => {
    const port = remoteAccess.getStatus().actualPort;
    const pairedAt = now;
    const { deviceId, keys, hostPublicKey, socket } = await pairDevice({ port });
    expect(remoteAccess.listDevices()[0].lastSeen).toBe(pairedAt);

    const client = createClient({
      url: wsUrl(port),
      WebSocket,
      keys,
      hostPublicKey,
      deviceId,
    });
    await client.connect();

    now += 30 * 1000;
    await client.request('ping');
    expect(remoteAccess.listDevices()[0].lastSeen).toBe(pairedAt);

    now += 31 * 1000;
    await client.request('ping');
    expect(remoteAccess.listDevices()[0].lastSeen).toBe(pairedAt + 61 * 1000);
    client.close();
    socket.close();
  });
});

describe('close codes', () => {
  it('lives in the application range', () => {
    for (const code of [CLOSE_REVOKED, CLOSE_DISCONNECT_ALL]) {
      expect(code).toBeGreaterThanOrEqual(4000);
      expect(code).toBeLessThan(5000);
    }
    expect(CLOSE_REVOKED).not.toBe(CLOSE_DISCONNECT_ALL);
  });
});
