import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  newKeyPair,
  sealFrame,
  openFrame,
  randomNonce,
  createClient,
} from '../shared/remote-protocol/index.cjs';

// The client half's connection contract (#142), driven against a bare ws
// server so the invariants are pinned without the whole Remote Access
// service. The phone keeps one client for the life of a host and redials
// through it after every drop, so a client that cannot be reconnected is a
// phone that goes dead on the first network blip.

const hostKeys = newKeyPair();

// Stands in for the Mac: opens every frame, enforces the per-connection
// counter and channel binding the real server enforces, answers the hello
// with the connected event and `ping` with pong. Records what it saw so a
// test can assert the counters restarted rather than resumed.
function fakeMac() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const seen = []; // one array of counters per connection
  const sockets = new Set();
  wss.on('connection', (ws, req) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    const counters = [];
    seen.push(counters);
    let inCounter = 0;
    let outCounter = 0;
    let channel = null;
    let devicePublicKey = null;
    const send = (payload) => {
      outCounter += 1;
      const sealed = sealFrame({
        payload: { ...payload, ch: channel, n: outCounter },
        senderSecret: hostKeys.secretKey,
        recipientPublicKey: devicePublicKey,
        nonce: randomNonce(),
      });
      ws.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          counter: outCounter,
          nonce: sealed.nonce,
          box: sealed.box,
        })
      );
    };
    ws.on('message', (raw) => {
      const outer = JSON.parse(String(raw));
      counters.push(outer.counter);
      // Exactly the server's rule: 1 on a fresh connection, then +1.
      if (outer.counter !== inCounter + 1) {
        ws.close();
        return;
      }
      inCounter = outer.counter;
      devicePublicKey = devicePublicKey || decodeDeviceKey(req);
      const payload = openFrame({
        nonce: outer.nonce,
        box: outer.box,
        senderPublicKey: devicePublicKey,
        recipientSecret: hostKeys.secretKey,
      });
      if (payload.n !== outer.counter) return ws.close();
      if (!channel) {
        if (payload.kind !== 'hello') return ws.close();
        channel = `${payload.clientNonce}.mac-${seen.length}`;
        send({ kind: 'event', name: 'connected', payload: { deviceId: 'device-1' } });
        return;
      }
      if (payload.ch !== channel) return ws.close();
      send({ kind: 'response', id: payload.id, result: { pong: true } });
    });
  });
  // The device key is fixed per test run; the handshake that would carry it
  // is the pairing ticket's own concern, not this file's.
  let pinned = null;
  function decodeDeviceKey() {
    return pinned;
  }
  return {
    url: () => `ws://127.0.0.1:${wss.address().port}/wpxen-device`,
    pinDeviceKey: (key) => {
      pinned = key;
    },
    counters: () => seen,
    dropAll: () => {
      for (const ws of [...sockets]) ws.close();
    },
    listening: () =>
      new Promise((resolve) => {
        if (wss.address()) resolve();
        else wss.once('listening', resolve);
      }),
    close: () =>
      new Promise((resolve) => {
        for (const ws of [...sockets]) ws.terminate();
        wss.close(resolve);
      }),
  };
}

let mac = null;

afterEach(async () => {
  if (mac) await mac.close();
  mac = null;
});

async function connectClient() {
  await mac.listening();
  const keys = newKeyPair();
  mac.pinDeviceKey(keys.publicKey);
  return createClient({
    url: mac.url(),
    WebSocket,
    keys,
    hostPublicKey: hostKeys.publicKey,
    deviceId: 'device-1',
  });
}

async function waitFor(fn, label) {
  const deadline = Date.now() + 2000;
  while (!fn() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  if (!fn()) throw new Error(`timed out waiting for ${label}`);
}

describe('createClient connection lifecycle', () => {
  it('reconnects after a server-side drop, restarting the counters', async () => {
    mac = fakeMac();
    const client = await connectClient();
    await client.connect();
    expect(await client.request('ping')).toMatchObject({ pong: true });

    const closes = [];
    client.onClose(() => closes.push(1));
    mac.dropAll();
    await waitFor(() => closes.length === 1, 'the drop to reach the client');

    // The same client dials again and the channel works. The server counts
    // from 1 per connection, so a client that resumed at N+1 is dropped on
    // its first frame.
    await client.connect();
    expect(await client.request('ping')).toMatchObject({ pong: true });
    expect(await client.request('ping')).toMatchObject({ pong: true });

    // Each connection opens with its hello (1), then counts on from there.
    const perConnection = mac.counters();
    expect(perConnection).toHaveLength(2);
    expect(perConnection[0]).toEqual([1, 2]);
    expect(perConnection[1]).toEqual([1, 2, 3]);
    client.close();
  });

  it('reconnects after an explicit close', async () => {
    mac = fakeMac();
    const client = await connectClient();
    await client.connect();
    expect(await client.request('ping')).toMatchObject({ pong: true });

    client.close();
    await client.connect();
    expect(await client.request('ping')).toMatchObject({ pong: true });
    expect(mac.counters().map((c) => c[0])).toEqual([1, 1]);
    client.close();
  });

  it('reports one close per connection, not one per spent socket', async () => {
    mac = fakeMac();
    const client = await connectClient();
    await client.connect();
    let closes = 0;
    client.onClose(() => {
      closes += 1;
    });

    // Close and immediately redial: the first socket's close event lands
    // after the new dial has begun, and must not be reported against it.
    client.close();
    await client.connect();
    await new Promise((r) => setTimeout(r, 50));
    expect(closes).toBe(1);
    expect(await client.request('ping')).toMatchObject({ pong: true });
    client.close();
    expect(closes).toBe(2);
  });
});
