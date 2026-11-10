'use strict';

// Opening a device channel (protocol v2), after Orca's mobile E2EE v2
// handshake (mobile-e2ee-v2-desktop-session.ts). Three messages, then
// sealed frames:
//
//   phone → Mac  { v, type: 'hello', deviceId, clientNonce, ephemeralKey }
//   Mac → phone  { v, type: 'ready', serverNonce, ephemeralKey }
//   phone → Mac  { v, frame }   frame 0, sealed: { kind: 'auth', deviceId }
//   Mac → phone  { v, frame }   frame 0, sealed: the 'connected' event
//
// The hello and ready are plaintext and carry nothing secret: fresh
// ephemeral public keys and 32-byte nonces from each end. Both ends then
// derive this connection's keys (keySchedule.cjs). Only the paired phone can
// derive them — the static shared key needs its long-term secret — and only
// for *this* socket, because the Mac's nonce is new on every one. So the
// auth frame opening is the proof: a hello copied off the wire and replayed
// gets a ready like any other, then can't produce an auth frame, and the
// socket is reaped. Nothing about a device — connected-now, last seen,
// pushes, keep-awake — happens before auth. The connected event opening on
// the phone proves the Mac the same way (it needs the host's long-term
// secret).
//
// Every function here is pure; randomness comes from the caller.

const { PROTOCOL_VERSION } = require('./protocol.cjs');
const { encodeBase64, decodeBase64 } = require('./base64.cjs');
const { newKeyPair, drawRandom } = require('./keys.cjs');
const {
  KEY_LENGTH,
  NONCE_LENGTH,
  channelTranscript,
  sharedKey,
  deriveChannelKeys,
} = require('./keySchedule.cjs');
const { createChannelSession } = require('./channelFraming.cjs');

// Device names and ids travel in the hello; bound them before any work.
const MAX_DEVICE_ID_LENGTH = 128;

function decodeExact(text, length) {
  if (typeof text !== 'string') return null;
  try {
    const bytes = decodeBase64(text);
    return bytes.length === length ? bytes : null;
  } catch {
    return null;
  }
}

function validDeviceId(deviceId) {
  return (
    typeof deviceId === 'string' &&
    deviceId.length > 0 &&
    deviceId.length <= MAX_DEVICE_ID_LENGTH
  );
}

// Phone, step 1. `pending` stays on the phone until the ready arrives.
function createHello({ deviceId, randomBytes }) {
  if (!validDeviceId(deviceId)) throw new Error('Invalid device id.');
  const ephemeral = newKeyPair(randomBytes);
  const clientNonce = drawRandom(randomBytes, NONCE_LENGTH);
  return {
    message: {
      v: PROTOCOL_VERSION,
      type: 'hello',
      deviceId,
      clientNonce: encodeBase64(clientNonce),
      ephemeralKey: encodeBase64(ephemeral.publicKey),
    },
    pending: { deviceId, ephemeral, clientNonce },
  };
}

// The shape check the Mac runs before looking anything up.
function parseHello(hello) {
  if (!hello || typeof hello !== 'object' || hello.type !== 'hello') return null;
  if (hello.v !== PROTOCOL_VERSION || !validDeviceId(hello.deviceId)) return null;
  const clientNonce = decodeExact(hello.clientNonce, NONCE_LENGTH);
  const clientEphemeralKey = decodeExact(hello.ephemeralKey, KEY_LENGTH);
  if (!clientNonce || !clientEphemeralKey) return null;
  return { deviceId: hello.deviceId, clientNonce, clientEphemeralKey };
}

// Mac, step 2: a fresh nonce and ephemeral key for this socket, and the
// channel those keys open. Null for a malformed hello. The device's
// long-term public key comes from its stored record — the hello never
// chooses it.
function acceptHello({ hello, hostKeys, devicePublicKey, randomBytes }) {
  const parsed = parseHello(hello);
  if (!parsed) return null;
  const ephemeral = newKeyPair(randomBytes);
  const serverNonce = drawRandom(randomBytes, NONCE_LENGTH);
  const transcript = channelTranscript({
    version: PROTOCOL_VERSION,
    deviceId: parsed.deviceId,
    hostPublicKey: hostKeys.publicKey,
    devicePublicKey,
    clientEphemeralKey: parsed.clientEphemeralKey,
    serverEphemeralKey: ephemeral.publicKey,
    clientNonce: parsed.clientNonce,
    serverNonce,
  });
  const keys = deriveChannelKeys({
    staticShared: sharedKey(hostKeys.secretKey, devicePublicKey),
    ephemeralShared: sharedKey(ephemeral.secretKey, parsed.clientEphemeralKey),
    clientNonce: parsed.clientNonce,
    serverNonce,
    transcript,
  });
  return {
    deviceId: parsed.deviceId,
    reply: {
      v: PROTOCOL_VERSION,
      type: 'ready',
      serverNonce: encodeBase64(serverNonce),
      ephemeralKey: encodeBase64(ephemeral.publicKey),
    },
    session: createChannelSession({ keys, role: 'mac' }),
  };
}

// Phone, step 3: derive the same keys, or null for a malformed ready. The
// caller sends `session.seal(authPayload(deviceId))` as frame 0.
function completeHandshake({ pending, ready, deviceKeys, hostPublicKey }) {
  if (!ready || typeof ready !== 'object' || ready.type !== 'ready') return null;
  if (ready.v !== PROTOCOL_VERSION) return null;
  const serverNonce = decodeExact(ready.serverNonce, NONCE_LENGTH);
  const serverEphemeralKey = decodeExact(ready.ephemeralKey, KEY_LENGTH);
  if (!serverNonce || !serverEphemeralKey) return null;
  const transcript = channelTranscript({
    version: PROTOCOL_VERSION,
    deviceId: pending.deviceId,
    hostPublicKey,
    devicePublicKey: deviceKeys.publicKey,
    clientEphemeralKey: pending.ephemeral.publicKey,
    serverEphemeralKey,
    clientNonce: pending.clientNonce,
    serverNonce,
  });
  const keys = deriveChannelKeys({
    staticShared: sharedKey(deviceKeys.secretKey, hostPublicKey),
    ephemeralShared: sharedKey(pending.ephemeral.secretKey, serverEphemeralKey),
    clientNonce: pending.clientNonce,
    serverNonce,
    transcript,
  });
  return createChannelSession({ keys, role: 'phone' });
}

function authPayload(deviceId) {
  return { kind: 'auth', deviceId };
}

function isAuthPayload(payload, deviceId) {
  return (
    !!payload &&
    typeof payload === 'object' &&
    payload.kind === 'auth' &&
    payload.deviceId === deviceId
  );
}

module.exports = {
  MAX_DEVICE_ID_LENGTH,
  createHello,
  parseHello,
  acceptHello,
  completeHandshake,
  authPayload,
  isAuthPayload,
};
