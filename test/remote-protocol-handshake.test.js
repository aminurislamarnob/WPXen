import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_VERSION,
  newKeyPair,
  channelTranscript,
  sharedKey,
  deriveChannelKeys,
  createHello,
  acceptHello,
  completeHandshake,
  authPayload,
  isAuthPayload,
} from '../shared/remote-protocol/index.cjs';

// The v2 channel handshake and its key schedule (keySchedule.cjs,
// handshake.cjs), pure: no sockets. What these pin is why a copied hello
// is worthless — the Mac's fresh nonce goes into every key.

const host = newKeyPair();
const device = newKeyPair();
const deviceId = 'device-1';

function handshake({ hello = createHello({ deviceId }), deviceKeys = device } = {}) {
  const accepted = acceptHello({
    hello: hello.message,
    hostKeys: host,
    devicePublicKey: device.publicKey,
  });
  const phone = completeHandshake({
    pending: hello.pending,
    ready: accepted.reply,
    deviceKeys,
    hostPublicKey: host.publicKey,
  });
  return { hello, accepted, mac: accepted.session, phone };
}

describe('key schedule', () => {
  const fields = () => ({
    version: PROTOCOL_VERSION,
    deviceId,
    hostPublicKey: host.publicKey,
    devicePublicKey: device.publicKey,
    clientEphemeralKey: new Uint8Array(32).fill(1),
    serverEphemeralKey: new Uint8Array(32).fill(2),
    clientNonce: new Uint8Array(32).fill(3),
    serverNonce: new Uint8Array(32).fill(4),
  });
  const derive = (overrides = {}) => {
    const f = { ...fields(), ...overrides };
    return deriveChannelKeys({
      staticShared: new Uint8Array(32).fill(5),
      ephemeralShared: new Uint8Array(32).fill(6),
      clientNonce: f.clientNonce,
      serverNonce: f.serverNonce,
      transcript: channelTranscript(f),
      ...(overrides.staticShared ? { staticShared: overrides.staticShared } : {}),
    });
  };

  it('splits into one key per direction and a session id', () => {
    const keys = derive();
    expect(keys.phoneToMacKey).toHaveLength(32);
    expect(keys.macToPhoneKey).toHaveLength(32);
    expect(keys.sessionId).toHaveLength(32);
    expect(keys.phoneToMacKey).not.toEqual(keys.macToPhoneKey);
    expect(derive()).toEqual(keys);
  });

  it('changes with every transcript field and every secret', () => {
    const base = derive().phoneToMacKey;
    const variants = [
      { serverNonce: new Uint8Array(32).fill(9) },
      { clientNonce: new Uint8Array(32).fill(9) },
      { serverEphemeralKey: new Uint8Array(32).fill(9) },
      { clientEphemeralKey: new Uint8Array(32).fill(9) },
      { deviceId: 'device-2' },
      { version: PROTOCOL_VERSION + 1 },
      { hostPublicKey: newKeyPair().publicKey },
      { staticShared: new Uint8Array(32).fill(9) },
    ];
    for (const variant of variants) {
      expect(
        derive(variant).phoneToMacKey,
        JSON.stringify(Object.keys(variant))
      ).not.toEqual(base);
    }
  });

  it('refuses wrong-length inputs', () => {
    expect(() =>
      channelTranscript({ ...fields(), serverNonce: new Uint8Array(31) })
    ).toThrow(/server nonce/);
    expect(() => sharedKey(new Uint8Array(31), host.publicKey)).toThrow(/secret key/);
  });

  it('agrees on the static key from either side', () => {
    expect(sharedKey(host.secretKey, device.publicKey)).toEqual(
      sharedKey(device.secretKey, host.publicKey)
    );
  });
});

describe('channel handshake', () => {
  it('leaves both ends with one channel: auth, connected, requests', () => {
    const { mac, phone } = handshake();
    expect(isAuthPayload(mac.open(phone.seal(authPayload(deviceId))), deviceId)).toBe(
      true
    );
    expect(phone.open(mac.seal({ kind: 'event', name: 'connected' }))).toMatchObject({
      name: 'connected',
    });
    expect(mac.open(phone.seal({ kind: 'request', id: 'r1' }))).toMatchObject({
      id: 'r1',
    });
  });

  it('a replayed hello gets new keys, so the copied auth frame cannot open', () => {
    const original = handshake();
    const auth = original.phone.seal(authPayload(deviceId));
    expect(original.mac.open(auth)).toEqual(authPayload(deviceId));

    // The same hello, byte for byte, on a new socket: the Mac draws a new
    // nonce and ephemeral key, so neither the old auth frame nor anything
    // sealed under the old keys opens.
    const replay = acceptHello({
      hello: original.hello.message,
      hostKeys: host,
      devicePublicKey: device.publicKey,
    });
    expect(replay.reply.serverNonce).not.toBe(original.accepted.reply.serverNonce);
    expect(replay.session.open(auth)).toBeNull();
  });

  it('a phone without the device secret derives keys that do not open', () => {
    const { mac, phone } = handshake({ deviceKeys: newKeyPair() });
    expect(mac.open(phone.seal(authPayload(deviceId)))).toBeNull();
  });

  it('a Mac without the host secret cannot answer as the Mac', () => {
    const hello = createHello({ deviceId });
    const impostor = acceptHello({
      hello: hello.message,
      hostKeys: newKeyPair(),
      devicePublicKey: device.publicKey,
    });
    const phone = completeHandshake({
      pending: hello.pending,
      ready: impostor.reply,
      deviceKeys: device,
      hostPublicKey: host.publicKey,
    });
    expect(
      phone.open(impostor.session.seal({ kind: 'event', name: 'connected' }))
    ).toBeNull();
  });

  it('refuses malformed hellos and readies', () => {
    const { message, pending } = createHello({ deviceId });
    const accept = (hello) =>
      acceptHello({ hello, hostKeys: host, devicePublicKey: device.publicKey });
    expect(accept({ ...message, v: PROTOCOL_VERSION - 1 })).toBeNull();
    expect(accept({ ...message, type: 'pair-request' })).toBeNull();
    expect(accept({ ...message, clientNonce: 'AAAA' })).toBeNull();
    expect(accept({ ...message, ephemeralKey: 42 })).toBeNull();
    expect(accept({ ...message, deviceId: 'x'.repeat(200) })).toBeNull();
    expect(accept(null)).toBeNull();
    const ready = accept(message).reply;
    const complete = (r) =>
      completeHandshake({
        pending,
        ready: r,
        deviceKeys: device,
        hostPublicKey: host.publicKey,
      });
    expect(complete({ ...ready, v: PROTOCOL_VERSION + 1 })).toBeNull();
    expect(complete({ ...ready, serverNonce: '' })).toBeNull();
    expect(complete({ ...ready, type: 'hello' })).toBeNull();
  });
});
