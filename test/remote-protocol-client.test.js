import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { newKeyPair, createClient } from '../shared/remote-protocol/index.cjs';
import { createMacEnd } from './helpers/macEnd.js';

// The client half's connection contract (#142), driven against a bare ws
// server so the invariants are pinned without the whole Remote Access
// service. The phone keeps one client for the life of a host and redials
// through it after every drop, so a client that cannot be reconnected is a
// phone that goes dead on the first network blip.

const hostKeys = newKeyPair();

// Stands in for the Mac: runs the shared handshake per connection
// (helpers/macEnd.js), answers `ping` with pong, and records the sealed
// frames each connection opened so a test can assert that every connection
// starts over at frame 0 rather than resuming.
function fakeMac() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const seen = []; // one array of opened frame counters per connection
  const sockets = new Set();
  let pinned = null;
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    const end = createMacEnd({
      hostKeys,
      devicePublicKey: pinned,
      deviceId: 'device-1',
    });
    seen.push(end.opened);
    ws.on('message', (raw) => {
      const result = end.receive(raw);
      if (result.close) return ws.close();
      if (result.reply) return ws.send(JSON.stringify(result.reply));
      const { payload } = result;
      ws.send(
        JSON.stringify(
          end.seal({ kind: 'response', id: payload.id, result: { pong: true } })
        )
      );
    });
  });
  return {
    url: () => `ws://127.0.0.1:${wss.address().port}/wpxen-device`,
    // The device key is fixed per test run; pairing is not this file's concern.
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

    // The same client dials again and the channel works. Each connection
    // has its own keys and counts from frame 0, so a client that resumed its
    // old counter (or kept its old keys) is dropped on its first frame.
    await client.connect();
    expect(await client.request('ping')).toMatchObject({ pong: true });
    expect(await client.request('ping')).toMatchObject({ pong: true });

    // Each connection opens with its auth frame (0), then counts on.
    const perConnection = mac.counters();
    expect(perConnection).toHaveLength(2);
    expect(perConnection[0]).toEqual([0, 1]);
    expect(perConnection[1]).toEqual([0, 1, 2]);
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
    expect(mac.counters().map((c) => c[0])).toEqual([0, 0]);
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
