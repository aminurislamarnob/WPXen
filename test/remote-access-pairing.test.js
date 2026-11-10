import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import remoteAccess, {
  HOST_ID_KEY,
  HOST_KEY_KEY,
} from '../electron/services/remoteAccess.cjs';
import {
  PROTOCOL_VERSION,
  PAIR_ERRORS,
  CLOSE_REVOKED,
  newKeyPair,
  publicKeyB64,
  confirmationCode,
  parsePairingUrl,
  createPairRequest,
  openPairAccept,
  createClient,
  decodeBase64,
  createHello,
  completeHandshake,
  authPayload,
  DIAL_ERRORS,
} from '../shared/remote-protocol/index.cjs';
import { createMacEnd } from './helpers/macEnd.js';

// Device pairing and the encrypted channel (#142): the real localhost server
// on 127.0.0.1:0, driven by the real client half of the shared protocol
// module as the phone. Prompt, clock, ids and secure storage come through
// `__setDeps`.

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
let promptCalls;
let promptBehavior;
let paired;

function listen() {
  const status = remoteAccess.getStatus();
  if (status.state !== 'listening') throw new Error('server is not listening');
  return status.actualPort;
}

function wsUrl(port) {
  return `ws://127.0.0.1:${port}/wpxen-device`;
}

// One raw pairing attempt with an explicit secret against the live offer —
// no fresh offer, so reuse and guessing hit the same offer state.
async function rawAttempt({
  port,
  keys,
  secret,
  hostPublicKey,
  version = PROTOCOL_VERSION,
}) {
  const { message } = createPairRequest({
    secret,
    deviceName: 'Phone',
    platform: 'ios',
    keys,
    hostPublicKey,
    version,
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
  return { socket, reply };
}
async function pairPhone({
  port,
  keys,
  secret,
  deviceName = 'My iPhone',
  platform = 'ios',
}) {
  const offer = await remoteAccess.pairingOffer({ hostname: HOSTNAME });
  const parsed = parsePairingUrl(offer.url);
  const hostPublicKey = decodeBase64(parsed.hostPublicKeyB64);
  const { message, code } = createPairRequest({
    secret: secret ?? parsed.secret,
    deviceName,
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
    socket.on('message', (data) => resolve(data.toString()));
    socket.send(JSON.stringify(message));
  });
  return { socket, reply: JSON.parse(reply), code, hostPublicKey, offer };
}

beforeEach(async () => {
  store = fakeStore({ [HOST_ID_KEY]: 'test-host-id' });
  now = Date.now();
  promptCalls = [];
  paired = [];
  promptBehavior = 'allow';
  remoteAccess.__setDeps({
    store,
    safeStorage: fakeSafeStorage(),
    randomId: () => 'test-id',
    now: () => now,
    pairTimeoutMs: 500,
    promptPairing: async (info) => {
      promptCalls.push(info);
      if (promptBehavior === 'allow') return 'allow';
      if (promptBehavior === 'deny') return 'deny';
      return new Promise(() => {});
    },
    onPaired: (info) => paired.push(info),
    machineName: () => 'Studio Mac',
    getRemoteConfig: () => ({ enabled: true, port: 6780, hostname: HOSTNAME }),
  });
  remoteAccess.start({ port: 0 });
  const start = Date.now();
  while (remoteAccess.getStatus().state !== 'listening') {
    if (Date.now() - start > 5000) throw new Error('server did not start');
    if (remoteAccess.getStatus().state === 'error')
      throw new Error('server failed to start');
    await new Promise((r) => setTimeout(r, 10));
  }
});

afterEach(() => {
  remoteAccess.dispose();
});

describe('pairing offer', () => {
  it('encodes version, host identity, public key, wss url and a one-time secret', async () => {
    const offer = await remoteAccess.pairingOffer({ hostname: HOSTNAME });
    expect(offer.qr.startsWith('data:image/png')).toBe(true);
    const parsed = parsePairingUrl(offer.url);
    expect(parsed.version).toBe(PROTOCOL_VERSION);
    expect(parsed.hostId).toBe('test-host-id');
    expect(parsed.wssUrl).toBe(`wss://${HOSTNAME}/wpxen-device`);
    expect(typeof parsed.secret).toBe('string');
    expect(parsed.secret.length).toBeGreaterThan(16);
    expect(parsed.hostPublicKeyB64.length).toBeGreaterThan(16);
    expect(offer.expiresAt).toBeGreaterThan(now);
  });

  it('expires after five minutes and works only once', async () => {
    const keys = newKeyPair();
    const port = listen();
    const first = await pairPhone({ port, keys });
    expect(first.reply.type).toBe('pair-accept');
    first.socket.close();

    // The same secret against the same (now consumed) offer: used, not valid.
    const offer = await remoteAccess.pairingOffer({ hostname: HOSTNAME });
    const parsed = parsePairingUrl(offer.url);
    const hostPublicKey = decodeBase64(parsed.hostPublicKeyB64);
    const used = await rawAttempt({
      port,
      keys: newKeyPair(),
      secret: parsed.secret,
      hostPublicKey,
    });
    expect(used.reply).toMatchObject({ type: 'pair-accept' });
    used.socket.close();
    const reuse = await rawAttempt({
      port,
      keys: newKeyPair(),
      secret: parsed.secret,
      hostPublicKey,
    });
    expect(reuse.reply).toMatchObject({
      type: 'pair-reject',
      reason: PAIR_ERRORS.pairingUsed,
    });
    reuse.socket.close();

    // Fresh offer, clock past expiry: the same secret no longer works.
    const fresh = await remoteAccess.pairingOffer({ hostname: HOSTNAME });
    const freshParsed = parsePairingUrl(fresh.url);
    now += 5 * 60 * 1000 + 1000;
    const late = await rawAttempt({
      port,
      keys: newKeyPair(),
      secret: freshParsed.secret,
      hostPublicKey: decodeBase64(freshParsed.hostPublicKeyB64),
    });
    expect(late.reply).toMatchObject({
      type: 'pair-reject',
      reason: PAIR_ERRORS.pairingExpired,
    });
    late.socket.close();
  });
});

describe('one use', () => {
  it('spends the secret on the first valid request, before the dialog answers', async () => {
    promptBehavior = 'silent';
    const port = listen();
    const offer = await remoteAccess.pairingOffer({ hostname: HOSTNAME });
    const parsed = parsePairingUrl(offer.url);
    const hostPublicKey = decodeBase64(parsed.hostPublicKeyB64);
    const attempt = () =>
      rawAttempt({ port, keys: newKeyPair(), secret: parsed.secret, hostPublicKey });

    // The first phone's request opens the dialog, which nobody answers yet.
    const first = attempt();
    while (promptCalls.length === 0) await new Promise((r) => setTimeout(r, 10));
    // A second phone with the same QR is refused outright — no second dialog.
    const second = await attempt();
    expect(second.reply).toMatchObject({
      type: 'pair-reject',
      reason: PAIR_ERRORS.pairingUsed,
    });
    expect(promptCalls).toHaveLength(1);
    second.socket.close();
    const { socket, reply } = await first;
    expect(reply).toMatchObject({ reason: PAIR_ERRORS.pairingTimeout });
    socket.close();
  });
});

describe('the Allow/Deny dialog lives as long as the request', () => {
  // A held prompt: resolves when the test says, records the signal it got.
  function heldPrompt() {
    let answer;
    const seen = {};
    remoteAccess.__setDeps({
      promptPairing: (info) => {
        seen.signal = info.signal;
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    });
    return { seen, answer: (v) => answer(v) };
  }

  async function startPairing(port) {
    const keys = newKeyPair();
    const offer = await remoteAccess.pairingOffer({ hostname: HOSTNAME });
    const parsed = parsePairingUrl(offer.url);
    const { message } = createPairRequest({
      secret: parsed.secret,
      deviceName: 'Phone',
      platform: 'ios',
      keys,
      hostPublicKey: decodeBase64(parsed.hostPublicKeyB64),
      version: PROTOCOL_VERSION,
    });
    const socket = new WebSocket(wsUrl(port));
    await new Promise((resolve) => socket.on('open', resolve));
    socket.send(JSON.stringify(message));
    return socket;
  }

  async function until(fn) {
    const deadline = Date.now() + 2000;
    while (!fn() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  }

  it('aborts the dialog when the phone hangs up, and a late Allow stores nothing', async () => {
    const prompt = heldPrompt();
    const socket = await startPairing(listen());
    await until(() => prompt.seen.signal);
    expect(prompt.seen.signal.aborted).toBe(false);
    socket.close();
    await until(() => prompt.seen.signal.aborted);
    expect(prompt.seen.signal.aborted).toBe(true);
    prompt.answer('allow');
    await new Promise((r) => setTimeout(r, 50));
    expect(remoteAccess.listDevices()).toEqual([]);
    expect(paired).toEqual([]);
  });

  it('aborts the dialog when the prompt times out', async () => {
    const prompt = heldPrompt();
    const socket = await startPairing(listen());
    await until(() => prompt.seen.signal);
    // pairTimeoutMs is 500 in these tests.
    await until(() => prompt.seen.signal.aborted);
    expect(prompt.seen.signal.aborted).toBe(true);
    socket.close();
  });
});

describe('confirmation code', () => {
  it('matches on both sides, and a swapped key changes it', () => {
    const host = newKeyPair();
    const device = newKeyPair();
    const a = confirmationCode(publicKeyB64(host), publicKeyB64(device), 'secret');
    const b = confirmationCode(publicKeyB64(host), publicKeyB64(device), 'secret');
    expect(a).toBe(b);
    expect(a).toMatch(/^\d{4}$/);
    const attacker = newKeyPair();
    expect(
      confirmationCode(publicKeyB64(host), publicKeyB64(attacker), 'secret')
    ).not.toBe(a);
  });

  it('is the code the Mac prompts with', async () => {
    const keys = newKeyPair();
    const port = listen();
    const { socket, code } = await pairPhone({ port, keys });
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0]).toMatchObject({
      deviceName: 'My iPhone',
      platform: 'ios',
      code,
    });
    socket.close();
  });
});

describe('handshake outcome', () => {
  it('Allow stores the device, returns its id and notifies', async () => {
    const keys = newKeyPair();
    const port = listen();
    const { socket, reply, hostPublicKey } = await pairPhone({ port, keys });
    expect(reply.type).toBe('pair-accept');
    expect(typeof reply.deviceId).toBe('string');

    const opened = openPairAccept({ message: reply, keys, hostPublicKey });
    expect(opened.deviceId).toBe(reply.deviceId);
    // The phone names the Mac by the Mac's name — it used to file it under
    // its own (deviceName), so every Mac read "My iPhone".
    expect(opened.machineName).toBe('Studio Mac');

    const devices = store.data.wpxenRemoteDevices;
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      id: reply.deviceId,
      name: 'My iPhone',
      platform: 'ios',
    });
    expect(paired).toEqual([{ name: 'My iPhone' }]);
    socket.close();
  });

  it('Deny and a silent prompt reject with distinct reasons', async () => {
    const port = listen();
    promptBehavior = 'deny';
    const denied = await pairPhone({ port, keys: newKeyPair() });
    expect(denied.reply).toMatchObject({
      type: 'pair-reject',
      reason: PAIR_ERRORS.pairingDenied,
    });
    expect(paired).toEqual([]);
    denied.socket.close();

    promptBehavior = 'silent';
    const timedOut = await pairPhone({ port, keys: newKeyPair() });
    expect(timedOut.reply).toMatchObject({
      type: 'pair-reject',
      reason: PAIR_ERRORS.pairingTimeout,
    });
    timedOut.socket.close();
  });
});

describe('encrypted channel', () => {
  async function pairedClient() {
    const keys = newKeyPair();
    const port = listen();
    const { socket, reply, hostPublicKey } = await pairPhone({ port, keys });
    expect(reply.type).toBe('pair-accept');
    const opened = openPairAccept({ message: reply, keys, hostPublicKey });
    socket.close();
    const client = createClient({
      url: wsUrl(port),
      WebSocket,
      keys,
      hostPublicKey,
      deviceId: opened.deviceId,
    });
    const events = [];
    client.subscribe('connected', (payload) => events.push(payload));
    await client.connect();
    return { client, events, deviceId: opened.deviceId, keys, hostPublicKey, port };
  }

  async function attackedSocket(port) {
    const rawSocket = new WebSocket(wsUrl(port));
    await new Promise((resolve) => rawSocket.on('open', resolve));
    const messages = [];
    rawSocket.on('message', (data) => messages.push(data.toString()));
    const closed = new Promise((resolve) => rawSocket.on('close', resolve));
    return { rawSocket, messages, closed };
  }

  async function nextMessage(messages, count) {
    const deadline = Date.now() + 2000;
    while (messages.length < count && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return messages[count - 1];
  }

  // A device channel opened by hand, message by message, with the shared
  // handshake — so a test can capture, alter and replay what crosses the
  // wire. `frame()` seals the next request under this connection's keys.
  async function rawChannel({ port, deviceId, keys, hostPublicKey }) {
    const sock = await attackedSocket(port);
    const { message, pending } = createHello({ deviceId });
    const hello = JSON.stringify(message);
    sock.rawSocket.send(hello);
    const ready = JSON.parse(await nextMessage(sock.messages, 1));
    const session = completeHandshake({
      pending,
      ready,
      deviceKeys: keys,
      hostPublicKey,
    });
    const seal = (payload) =>
      JSON.stringify({ v: PROTOCOL_VERSION, frame: session.seal(payload) });
    const auth = seal(authPayload(deviceId));
    sock.rawSocket.send(auth);
    // The connected event, sealed: the Mac proved its key too.
    const welcome = JSON.parse(await nextMessage(sock.messages, 2));
    expect(session.open(welcome.frame)).toMatchObject({
      kind: 'event',
      name: 'connected',
    });
    let seq = 0;
    const frame = () => {
      seq += 1;
      return seal({ kind: 'request', id: `r${seq}`, op: 'ping', params: {} });
    };
    return { ...sock, hello, auth, session, frame };
  }

  it('round-trips ping encrypted; the wire carries no plaintext JSON', async () => {
    const { client, events, deviceId } = await pairedClient();
    const result = await client.request('ping');
    expect(result).toMatchObject({ pong: true });
    expect(typeof result.serverTime).toBe('number');
    // The welcome event proves server → client encryption too, and names
    // the Mac on every connect so a rename since pairing reaches the phone.
    expect(events).toEqual([{ deviceId, machineName: 'Studio Mac' }]);
    client.close();
  });

  it('rejects replayed, reordered, tampered and undecryptable frames', async () => {
    const { deviceId, keys, hostPublicKey, port } = await pairedClient();
    const device = { port, deviceId, keys, hostPublicKey };

    // Replay: a valid frame, then its identical twin.
    {
      const chan = await rawChannel(device);
      const wire = chan.frame();
      // The wire carries no plaintext JSON: the result is sealed inside.
      expect(wire).not.toContain('ping');
      chan.rawSocket.send(wire);
      expect(await nextMessage(chan.messages, 3)).not.toContain('pong');
      chan.rawSocket.send(wire);
      await chan.closed;
      expect(chan.messages).toHaveLength(3);
    }

    // Reorder: the second frame before the first.
    {
      const chan = await rawChannel(device);
      chan.frame();
      chan.rawSocket.send(chan.frame());
      await chan.closed;
      expect(chan.messages).toHaveLength(2); // ready + connected, nothing more
    }

    // Tampered: one flipped character in the frame.
    {
      const chan = await rawChannel(device);
      const wire = JSON.parse(chan.frame());
      wire.frame =
        wire.frame.slice(0, 40) +
        (wire.frame[40] === 'A' ? 'B' : 'A') +
        wire.frame.slice(41);
      chan.rawSocket.send(JSON.stringify(wire));
      await chan.closed;
      expect(chan.messages).toHaveLength(2);
    }

    // Reflected: the Mac's own frame sent back to it. Same connection, same
    // counter, but sealed for the other direction under the other key.
    {
      const chan = await rawChannel(device);
      chan.rawSocket.send(chan.messages[1]);
      await chan.closed;
      expect(chan.messages).toHaveLength(2);
    }
  });

  it('refuses a frame captured on one connection and replayed on another', async () => {
    const { client, deviceId, keys, hostPublicKey, port } = await pairedClient();
    client.close();
    const device = { port, deviceId, keys, hostPublicKey };

    // The phone's real connection: hello, auth, then a request answered.
    const original = await rawChannel(device);
    const captured = original.frame();
    original.rawSocket.send(captured);
    await nextMessage(original.messages, 3);
    original.rawSocket.close();
    await original.closed;
    await new Promise((r) => setTimeout(r, 50));
    expect(remoteAccess.listDevices()[0].connected).toBe(false);

    // Someone in the path dials again with the captured frame first.
    {
      const sock = await attackedSocket(port);
      sock.rawSocket.send(captured);
      await sock.closed;
      expect(sock.messages).toEqual([]);
    }

    // Or replays the whole conversation: the hello earns a ready with a new
    // server nonce, so this connection's keys are ones the copy never had and
    // the captured auth frame cannot open.
    {
      const sock = await attackedSocket(port);
      sock.rawSocket.send(original.hello);
      await nextMessage(sock.messages, 1);
      expect(JSON.parse(sock.messages[0]).type).toBe('ready');
      expect(remoteAccess.listDevices()[0].connected).toBe(false);
      sock.rawSocket.send(original.auth);
      sock.rawSocket.send(captured);
      await sock.closed;
      expect(sock.messages).toHaveLength(1);
      expect(remoteAccess.listDevices()[0].connected).toBe(false);
    }
  });

  it('tracks a socket as the device only once its auth frame opens', async () => {
    const { deviceId, client } = await pairedClient();
    client.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(remoteAccess.listDevices()[0].connected).toBe(false);

    // A hello for a real device is answered — that proves nothing — and the
    // device stays disconnected through an auth frame that doesn't open.
    const sock = await attackedSocket(remoteAccess.getStatus().actualPort);
    sock.rawSocket.send(JSON.stringify(createHello({ deviceId }).message));
    await nextMessage(sock.messages, 1);
    expect(remoteAccess.listDevices()[0].connected).toBe(false);
    sock.rawSocket.send(JSON.stringify({ v: PROTOCOL_VERSION, frame: 'AAAA' }));
    await sock.closed;
    expect(sock.messages).toHaveLength(1);
    expect(remoteAccess.listDevices()[0].connected).toBe(false);
  });

  it('refuses unknown device ids with the revoked code and no message', async () => {
    const port = listen();
    const { rawSocket } = await attackedSocket(port);
    const closed = new Promise((resolve) =>
      rawSocket.on('close', (code) => resolve(code))
    );
    let answered = false;
    rawSocket.on('message', () => (answered = true));
    rawSocket.send(JSON.stringify(createHello({ deviceId: 'no-such-device' }).message));
    expect(await closed).toBe(CLOSE_REVOKED);
    expect(answered).toBe(false);
  });

  it('tells a paired phone on another version which side to update', async () => {
    const { client, deviceId } = await pairedClient();
    client.close();
    for (const [v, update] of [
      [PROTOCOL_VERSION + 1, 'desktop'],
      [PROTOCOL_VERSION - 1, 'phone'],
    ]) {
      const sock = await attackedSocket(listen());
      sock.rawSocket.send(JSON.stringify({ ...createHello({ deviceId }).message, v }));
      await sock.closed;
      expect(sock.messages.map((m) => JSON.parse(m))).toEqual([
        {
          v: PROTOCOL_VERSION,
          type: 'error',
          reason: PAIR_ERRORS.versionMismatch,
          update,
        },
      ]);
    }
  });

  it("rejects the client's connect with the side to update", async () => {
    class OtherVersionMac {
      static OPEN = 1;
      constructor() {
        this.readyState = 1;
        queueMicrotask(() => this.onopen?.());
      }
      send() {
        const data = JSON.stringify({
          v: PROTOCOL_VERSION + 1,
          type: 'error',
          reason: PAIR_ERRORS.versionMismatch,
          update: 'phone',
        });
        queueMicrotask(() => this.onmessage?.({ data }));
      }
      close() {}
    }
    const client = createClient({
      url: 'ws://127.0.0.1:1',
      WebSocket: OtherVersionMac,
      keys: newKeyPair(),
      hostPublicKey: newKeyPair().publicKey,
      deviceId: 'd',
    });
    await expect(client.connect()).rejects.toMatchObject({
      code: DIAL_ERRORS.versionMismatch,
      update: 'phone',
    });
  });

  it('rejects ops outside the allowlist', async () => {
    const { client } = await pairedClient();
    await expect(client.request('files.list')).rejects.toThrow(PAIR_ERRORS.opNotAllowed);
    client.close();
  });

  it('times out a request nothing answers, through an injected socket', async () => {
    // The constructor takes any WebSocket implementation. This one opens the
    // channel properly — it runs the Mac's half of the handshake — and then
    // goes quiet, like a server that stopped answering mid-session.
    const host = newKeyPair();
    const keys = newKeyPair();
    const end = createMacEnd({
      hostKeys: host,
      devicePublicKey: keys.publicKey,
      deviceId: 'd',
    });
    class GoesQuiet {
      static OPEN = 1;
      constructor() {
        this.readyState = 1;
        queueMicrotask(() => this.onopen?.());
      }
      send(raw) {
        const { reply } = end.receive(raw);
        if (!reply) return;
        const data = JSON.stringify(reply);
        queueMicrotask(() => this.onmessage?.({ data }));
      }
      close() {}
    }
    const client = createClient({
      url: 'ws://127.0.0.1:1',
      WebSocket: GoesQuiet,
      keys,
      hostPublicKey: host.publicKey,
      deviceId: 'd',
      requestTimeoutMs: 30,
    });
    await client.connect();
    await expect(client.request('ping')).rejects.toThrow(/timed out/);
    client.close();
  });

  it('gives up on a server that accepts the socket but never opens the channel', async () => {
    class BlackHole {
      static OPEN = 1;
      constructor() {
        this.readyState = 1;
        queueMicrotask(() => this.onopen?.());
      }
      send() {}
      close() {}
    }
    const client = createClient({
      url: 'ws://127.0.0.1:1',
      WebSocket: BlackHole,
      keys: newKeyPair(),
      hostPublicKey: newKeyPair().publicKey,
      deviceId: 'd',
      requestTimeoutMs: 30,
    });
    await expect(client.connect()).rejects.toThrow(/connect/);
  });

  it('fails a version mismatch naming which side to update', async () => {
    const port = listen();
    const keys = newKeyPair();
    const offer = await remoteAccess.pairingOffer({ hostname: HOSTNAME });
    const parsed = parsePairingUrl(offer.url);
    const { message } = createPairRequest({
      secret: parsed.secret,
      deviceName: 'Old Phone',
      platform: 'ios',
      keys,
      hostPublicKey: decodeBase64(parsed.hostPublicKeyB64),
      version: PROTOCOL_VERSION + 1,
    });
    const socket = new WebSocket(wsUrl(port));
    await new Promise((resolve) => socket.on('open', resolve));
    const reply = await new Promise((resolve) => {
      socket.on('message', (data) => resolve(JSON.parse(data.toString())));
      socket.send(JSON.stringify(message));
    });
    expect(reply).toMatchObject({
      type: 'pair-reject',
      reason: PAIR_ERRORS.versionMismatch,
    });
    expect(reply.update).toBe('desktop');
    socket.close();
  });

  it('rate-limits failed pairing attempts and invalidates the offer', async () => {
    const port = listen();
    const offer = await remoteAccess.pairingOffer({ hostname: HOSTNAME });
    const parsed = parsePairingUrl(offer.url);
    const attempt = async (secret) => {
      const keys = newKeyPair();
      const { message } = createPairRequest({
        secret,
        deviceName: 'Guesser',
        platform: 'ios',
        keys,
        hostPublicKey: decodeBase64(parsed.hostPublicKeyB64),
        version: PROTOCOL_VERSION,
      });
      const socket = new WebSocket(wsUrl(port));
      await new Promise((resolve) => socket.on('open', resolve));
      const reply = await new Promise((resolve) => {
        socket.on('message', (data) => resolve(JSON.parse(data.toString())));
        socket.send(JSON.stringify(message));
      });
      socket.close();
      return reply;
    };
    for (let i = 0; i < 5; i++) {
      const reply = await attempt('wrong-secret');
      expect(reply).toMatchObject({
        type: 'pair-reject',
        reason: PAIR_ERRORS.invalidSecret,
      });
    }
    const limited = await attempt('wrong-secret');
    expect(limited).toMatchObject({
      type: 'pair-reject',
      reason: PAIR_ERRORS.rateLimited,
    });
    // The offer died with the limit: past the rate window, even the real
    // secret reports an expired offer rather than pairing.
    now += 11 * 60 * 1000;
    const after = await attempt(parsed.secret);
    expect(after).toMatchObject({
      type: 'pair-reject',
      reason: PAIR_ERRORS.pairingExpired,
    });
  });

  it('keeps the Mac secret key out of the store file', async () => {
    const port = listen();
    await pairPhone({ port, keys: newKeyPair() });
    const raw = JSON.stringify(store.data);
    // Ciphertext only: no 32-byte secret in the clear, and the key lives
    // under its own wpxen-prefixed entry.
    expect(Object.keys(store.data).some((k) => k.startsWith('wpxen'))).toBe(true);
    expect(raw).not.toMatch(/"secretKey"|"secret"/);
  });

  it('drops a device socket when the host key no longer decrypts, and stays up', async () => {
    const port = listen();
    // A stored key the Keychain can no longer open: never regenerated (that
    // would un-pair every phone), so every dial must be refused — without
    // the throw escaping the connection event and taking the app down.
    store.set(HOST_KEY_KEY, 'ciphertext-from-another-keychain');
    const logs = [];
    remoteAccess.__setDeps({
      log: (line) => logs.push(line),
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: () => Buffer.from('x'),
        decryptString: () => {
          throw new Error('The data could not be decrypted.');
        },
      },
    });
    const socket = new WebSocket(wsUrl(port));
    const closed = new Promise((resolve) => socket.on('close', resolve));
    socket.on('error', () => {});
    await closed;
    expect(logs.join('\n')).toMatch(/unreadable/);
    // The server is still serving: a health check answers as before.
    const res = await fetch(`http://127.0.0.1:${port}/wpxen-health?nonce=n1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ nonce: 'n1', hostId: 'test-host-id' });
    expect(remoteAccess.getStatus().state).toBe('listening');
  });
});

describe('limits before auth', () => {
  async function openSocket(port, headers) {
    const socket = new WebSocket(wsUrl(port), headers ? { headers } : undefined);
    socket.on('error', () => {});
    const closed = new Promise((resolve) => socket.on('close', (code) => resolve(code)));
    await new Promise((resolve, reject) => {
      socket.on('open', resolve);
      socket.on('unexpected-response', reject);
    });
    return { socket, closed };
  }

  it('refuses a message over 1 MiB before reading it (ws allows 100 MiB)', async () => {
    const port = listen();
    const { socket, closed } = await openSocket(port);
    socket.send(
      JSON.stringify({ type: 'pair-request', pad: 'x'.repeat(2 * 1024 * 1024) })
    );
    // 1009: Message Too Big — refused by the server's maxPayload, not parsed.
    expect(await closed).toBe(1009);
  });

  it('holds at most 128 device sockets', async () => {
    const port = listen();
    const open = [];
    for (let i = 0; i < 128; i++) open.push(await openSocket(port));
    const extra = await openSocket(port);
    expect(await extra.closed).toBe(1013);
    for (const { socket } of open) socket.terminate();
  });

  it('strips control and bidi characters from the name and platform, capped at 64', async () => {
    const port = listen();
    const keys = newKeyPair();
    const { reply } = await pairPhone({
      port,
      keys,
      deviceName: '\u202eenohPi s\u2019kraM\u0007\n' + 'x'.repeat(100),
      platform: 'ios\u200b\u0000',
    });
    expect(reply.type).toBe('pair-accept');
    const shown = promptCalls[0];
    for (const ch of ['\u202e', '\u0007', '\n'])
      expect(shown.deviceName).not.toContain(ch);
    expect(shown.deviceName.length).toBe(64);
    expect(shown.platform).toBe('ios');
    const [stored] = remoteAccess.listDevices();
    expect(stored.name).toBe(shown.deviceName);
    expect(stored.platform).toBe('ios');
    // Nothing printable left falls back to the default label.
    expect(remoteAccess.sanitizeDeviceLabel('\u202e\u200b', 'Phone')).toBe('Phone');
  });

  it('charges failed attempts to the caller behind the tunnel, not to loopback', async () => {
    // Every phone reaches the server through cloudflared on 127.0.0.1, so
    // a per-address limit on the socket address was one shared bucket.
    const port = listen();
    const offer = await remoteAccess.pairingOffer({ hostname: HOSTNAME });
    const parsed = parsePairingUrl(offer.url);
    const attempt = async (ip) => {
      const { message } = createPairRequest({
        secret: 'wrong-secret',
        deviceName: 'Guesser',
        platform: 'ios',
        keys: newKeyPair(),
        hostPublicKey: decodeBase64(parsed.hostPublicKeyB64),
        version: PROTOCOL_VERSION,
      });
      const { socket } = await openSocket(port, { 'Cf-Connecting-Ip': ip });
      const reply = await new Promise((resolve) => {
        socket.on('message', (data) => resolve(JSON.parse(data.toString())));
        socket.send(JSON.stringify(message));
      });
      socket.close();
      return reply.reason;
    };
    for (let i = 0; i < 5; i++) {
      expect(await attempt('203.0.113.5')).toBe(PAIR_ERRORS.invalidSecret);
    }
    // Another phone, another address: not locked out by the first one.
    expect(await attempt('198.51.100.7')).toBe(PAIR_ERRORS.invalidSecret);
  });
});

describe('shared module portability guard', () => {
  it('uses no electron or Node-only APIs in the client path', () => {
    const dir = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'shared',
      'remote-protocol'
    );
    const files = [
      'index.cjs',
      'protocol.cjs',
      'base64.cjs',
      'keys.cjs',
      'confirm.cjs',
      'errors.cjs',
      'frames.cjs',
      'pairing.cjs',
      'keySchedule.cjs',
      'channelFraming.cjs',
      'handshake.cjs',
      'client.cjs',
    ];
    for (const file of files) {
      const raw = readFileSync(join(dir, file), 'utf8');
      // Comments may name things; only code counts.
      const source = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(source, `${file} requires electron`).not.toMatch(
        /require\(['"]electron['"]\)/
      );
      expect(source, `${file} uses Buffer`).not.toMatch(/\bBuffer\b/);
      expect(source, `${file} touches ws`).not.toMatch(/\brequire\(['"]ws['"]\)/);
      const requires = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(
        (m) => m[1]
      );
      for (const dep of requires) {
        expect(
          dep === 'tweetnacl' || dep.startsWith('./'),
          `${file} requires ${dep}`
        ).toBe(true);
      }
    }
  });
});
