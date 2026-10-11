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
  newKeyPair,
  publicKeyB64,
  confirmationCode,
  parsePairingUrl,
  createPairRequest,
  openPairAccept,
  createClient,
  decodeBase64,
  encodeBase64,
  sealFrame,
  openFrame,
  randomNonce,
} from '../shared/remote-protocol/index.cjs';

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

  function sealedFrame({ deviceId, counter, payload, secret, recipientPublicKey }) {
    const sealed = sealFrame({
      payload,
      senderSecret: secret,
      recipientPublicKey,
      nonce: randomNonce(),
    });
    return JSON.stringify({
      v: PROTOCOL_VERSION,
      deviceId,
      counter,
      nonce: sealed.nonce,
      box: sealed.box,
    });
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

  // A device channel opened by hand, frame by frame, so a test can capture
  // and replay what crosses the wire.
  async function rawChannel({ port, deviceId, keys, hostPublicKey }) {
    const sock = await attackedSocket(port);
    const hello = sealedFrame({
      deviceId,
      counter: 1,
      payload: { kind: 'hello', n: 1, clientNonce: encodeBase64(randomNonce()) },
      secret: keys.secretKey,
      recipientPublicKey: hostPublicKey,
    });
    sock.rawSocket.send(hello);
    const welcome = JSON.parse(await nextMessage(sock.messages, 1));
    const { ch } = openFrame({
      nonce: welcome.nonce,
      box: welcome.box,
      senderPublicKey: hostPublicKey,
      recipientSecret: keys.secretKey,
    });
    const frame = (n, extra = {}) =>
      sealedFrame({
        deviceId,
        counter: n,
        payload: {
          kind: 'request',
          id: `r${n}`,
          op: 'ping',
          params: {},
          ch,
          n,
          ...extra,
        },
        secret: keys.secretKey,
        recipientPublicKey: hostPublicKey,
      });
    return { ...sock, hello, ch, frame };
  }

  it('round-trips ping encrypted; the wire carries no plaintext JSON', async () => {
    const { client, events, deviceId } = await pairedClient();
    const result = await client.request('ping');
    expect(result).toMatchObject({ pong: true });
    expect(typeof result.serverTime).toBe('number');
    // The welcome event proves server → client encryption too.
    expect(events).toEqual([{ deviceId }]);
    client.close();
  });

  it('rejects replayed, reordered, tampered and undecryptable frames', async () => {
    const { deviceId, keys, hostPublicKey, port } = await pairedClient();
    const device = { port, deviceId, keys, hostPublicKey };

    // Replay: a valid frame, then its identical twin.
    {
      const chan = await rawChannel(device);
      const wire = chan.frame(2);
      // The wire carries no plaintext JSON: the result is sealed inside.
      expect(wire).not.toContain('pong');
      chan.rawSocket.send(wire);
      expect(await nextMessage(chan.messages, 2)).not.toContain('pong');
      chan.rawSocket.send(wire);
      await chan.closed;
      expect(chan.rawSocket.readyState).toBe(WebSocket.CLOSED);
    }

    // Reorder: counter 3 before 2.
    {
      const chan = await rawChannel(device);
      chan.rawSocket.send(chan.frame(3));
      await chan.closed;
      expect(chan.messages).toHaveLength(1); // the welcome, nothing for 3
    }

    // Tampered: one flipped character in the box.
    {
      const chan = await rawChannel(device);
      const wire = JSON.parse(chan.frame(2));
      wire.box =
        wire.box.slice(0, 10) + (wire.box[10] === 'A' ? 'B' : 'A') + wire.box.slice(11);
      chan.rawSocket.send(JSON.stringify(wire));
      await chan.closed;
      expect(chan.messages).toHaveLength(1);
    }

    // Undecryptable: a box sealed to nobody here.
    {
      const chan = await rawChannel(device);
      const stranger = newKeyPair();
      chan.rawSocket.send(
        sealedFrame({
          deviceId,
          counter: 2,
          payload: {
            kind: 'request',
            id: 'r2',
            op: 'ping',
            params: {},
            ch: chan.ch,
            n: 2,
          },
          secret: stranger.secretKey,
          recipientPublicKey: stranger.publicKey,
        })
      );
      await chan.closed;
      expect(chan.messages).toHaveLength(1);
    }
  });

  it('refuses a frame captured on one connection and replayed on another', async () => {
    const { deviceId, keys, hostPublicKey, port } = await pairedClient();
    const device = { port, deviceId, keys, hostPublicKey };

    // The phone's real connection: hello, then a request the Mac answers.
    const original = await rawChannel(device);
    const captured = original.frame(2);
    original.rawSocket.send(captured);
    expect(JSON.parse(await nextMessage(original.messages, 2)).counter).toBe(2);
    original.rawSocket.close();

    // Someone in the path dials again with the captured frame as the first.
    {
      const sock = await attackedSocket(port);
      sock.rawSocket.send(JSON.stringify({ ...JSON.parse(captured), counter: 1 }));
      await sock.closed;
      expect(sock.messages).toEqual([]);
    }

    // Or replays the captured hello too: the Mac opens a fresh channel, and
    // the request still names the old one.
    {
      const sock = await attackedSocket(port);
      sock.rawSocket.send(original.hello);
      await nextMessage(sock.messages, 1); // a welcome sealed to the phone
      sock.rawSocket.send(captured);
      await sock.closed;
      expect(sock.messages).toHaveLength(1);
    }

    // Moving a frame inside its own connection: the sealed counter disagrees
    // with the envelope's.
    {
      const chan = await rawChannel(device);
      const wire = JSON.parse(chan.frame(2));
      chan.rawSocket.send(chan.frame(2));
      await nextMessage(chan.messages, 2);
      chan.rawSocket.send(JSON.stringify({ ...wire, counter: 3 }));
      await chan.closed;
      expect(chan.messages).toHaveLength(2);
    }
  });

  it('tracks a socket as the device only once its hello opens', async () => {
    const { deviceId, client } = await pairedClient();
    client.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(remoteAccess.listDevices()[0].connected).toBe(false);

    // A known id with a counter but no verifiable box.
    const sock = await attackedSocket(remoteAccess.getStatus().actualPort);
    sock.rawSocket.send(
      JSON.stringify({ v: PROTOCOL_VERSION, deviceId, counter: 1, nonce: '', box: '' })
    );
    await sock.closed;
    expect(sock.messages).toEqual([]);
    expect(remoteAccess.listDevices()[0].connected).toBe(false);
  });

  it('drops unknown device ids without answering', async () => {
    const keys = newKeyPair();
    const port = listen();
    const hostKeys = newKeyPair();
    const { rawSocket, closed } = await attackedSocket(port);
    let answered = false;
    rawSocket.on('message', () => (answered = true));
    rawSocket.send(
      sealedFrame({
        deviceId: 'no-such-device',
        counter: 1,
        payload: { kind: 'request', id: 'r1', op: 'ping', params: {} },
        secret: keys.secretKey,
        recipientPublicKey: hostKeys.publicKey,
      })
    );
    await closed;
    expect(answered).toBe(false);
  });

  it('rejects ops outside the allowlist', async () => {
    const { client } = await pairedClient();
    await expect(client.request('files.list')).rejects.toThrow(PAIR_ERRORS.opNotAllowed);
    client.close();
  });

  it('times out a request nothing answers, through an injected socket', async () => {
    // The constructor takes any WebSocket implementation. This one opens the
    // channel properly — it answers the hello — and then goes quiet, like a
    // server that stopped answering mid-session.
    const host = newKeyPair();
    const keys = newKeyPair();
    class GoesQuiet {
      static OPEN = 1;
      constructor() {
        this.readyState = 1;
        queueMicrotask(() => this.onopen?.());
      }
      send(raw) {
        const outer = JSON.parse(raw);
        if (outer.counter !== 1) return;
        const { clientNonce } = openFrame({
          nonce: outer.nonce,
          box: outer.box,
          senderPublicKey: keys.publicKey,
          recipientSecret: host.secretKey,
        });
        const sealed = sealFrame({
          payload: { kind: 'event', name: 'connected', ch: `${clientNonce}.q`, n: 1 },
          senderSecret: host.secretKey,
          recipientPublicKey: keys.publicKey,
        });
        const data = JSON.stringify({ v: PROTOCOL_VERSION, counter: 1, ...sealed });
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
