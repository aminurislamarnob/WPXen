'use strict';

// Sealed frames on an open device channel (protocol v2), ported from Orca's
// mobile-e2ee-v2-framing.ts. Each frame is
//
//   nonce(24) ‖ secretbox(header(42) ‖ payload, nonce, directionKey)
//
//   nonce   sessionId[0..12) ‖ FRAME_VERSION ‖ direction ‖ kind ‖ 0 ‖ counter(u64 BE)
//   header  sessionId(32) ‖ direction ‖ kind ‖ counter(u64 BE)
//
// Nothing in a frame is random: the per-connection keys (keySchedule.cjs)
// make the nonce unique, and the receiver *recomputes* it from what it
// expects next — this connection's session, the peer's direction, the kind,
// and exactly the next counter — then requires the decrypted header to match
// byte for byte. So a frame replayed (counter behind), skipped ahead (gap),
// reflected back at its sender (direction), read as the other kind, or moved
// to another connection (session, and the key with it) never opens.
//
// Counters are plain numbers (Hermes has BigInt, but there is no need):
// a connection would have to send 2^53 frames to run out.

const nacl = require('tweetnacl');
const { encodeBase64, decodeBase64 } = require('./base64.cjs');

const NONCE_LENGTH = 24;
const SESSION_ID_LENGTH = 32;
const HEADER_LENGTH = SESSION_ID_LENGTH + 1 + 1 + 8;
const FRAME_VERSION = 2;

const DIRECTIONS = { 'phone-to-mac': 0, 'mac-to-phone': 1 };
const KINDS = { text: 0, binary: 1 };

function directionByte(direction) {
  if (!(direction in DIRECTIONS)) throw new Error(`Unknown direction: ${direction}`);
  return DIRECTIONS[direction];
}

function kindByte(kind) {
  if (!(kind in KINDS)) throw new Error(`Unknown payload kind: ${kind}`);
  return KINDS[kind];
}

function writeUint64(target, offset, value) {
  const high = Math.floor(value / 2 ** 32);
  const low = value >>> 0;
  target[offset] = (high >>> 24) & 0xff;
  target[offset + 1] = (high >>> 16) & 0xff;
  target[offset + 2] = (high >>> 8) & 0xff;
  target[offset + 3] = high & 0xff;
  target[offset + 4] = (low >>> 24) & 0xff;
  target[offset + 5] = (low >>> 16) & 0xff;
  target[offset + 6] = (low >>> 8) & 0xff;
  target[offset + 7] = low & 0xff;
}

function validate(key, sessionId, counter) {
  if (!(key instanceof Uint8Array) || key.length !== nacl.secretbox.keyLength) {
    throw new Error('Invalid channel key length.');
  }
  if (!(sessionId instanceof Uint8Array) || sessionId.length !== SESSION_ID_LENGTH) {
    throw new Error('Invalid channel session id length.');
  }
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new Error(`Invalid channel counter: ${counter}`);
  }
}

function encodeHeader({ sessionId, direction, kind, counter }) {
  const header = new Uint8Array(HEADER_LENGTH);
  header.set(sessionId, 0);
  header[SESSION_ID_LENGTH] = directionByte(direction);
  header[SESSION_ID_LENGTH + 1] = kindByte(kind);
  writeUint64(header, SESSION_ID_LENGTH + 2, counter);
  return header;
}

function encodeNonce({ sessionId, direction, kind, counter }) {
  const nonce = new Uint8Array(NONCE_LENGTH);
  nonce.set(sessionId.subarray(0, 12), 0);
  nonce[12] = FRAME_VERSION;
  nonce[13] = directionByte(direction);
  nonce[14] = kindByte(kind);
  nonce[15] = 0;
  writeUint64(nonce, 16, counter);
  return nonce;
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function sealChannelFrame({ payload, key, sessionId, direction, kind, counter }) {
  validate(key, sessionId, counter);
  const fields = { sessionId, direction, kind, counter };
  const header = encodeHeader(fields);
  const nonce = encodeNonce(fields);
  const plaintext = new Uint8Array(HEADER_LENGTH + payload.length);
  plaintext.set(header, 0);
  plaintext.set(payload, HEADER_LENGTH);
  const box = nacl.secretbox(plaintext, nonce, key);
  const frame = new Uint8Array(NONCE_LENGTH + box.length);
  frame.set(nonce, 0);
  frame.set(box, NONCE_LENGTH);
  return frame;
}

// The payload, or null for any frame that is not exactly the next one
// expected from this direction on this connection.
function openChannelFrame({ frame, key, sessionId, direction, kind, expectedCounter }) {
  validate(key, sessionId, expectedCounter);
  if (
    !(frame instanceof Uint8Array) ||
    frame.length < NONCE_LENGTH + nacl.secretbox.overheadLength + HEADER_LENGTH
  ) {
    return null;
  }
  const expected = { sessionId, direction, kind, counter: expectedCounter };
  const nonce = encodeNonce(expected);
  if (!equalBytes(frame.subarray(0, NONCE_LENGTH), nonce)) return null;
  const plaintext = nacl.secretbox.open(frame.subarray(NONCE_LENGTH), nonce, key);
  if (!plaintext) return null;
  if (!equalBytes(plaintext.subarray(0, HEADER_LENGTH), encodeHeader(expected))) {
    return null;
  }
  return plaintext.slice(HEADER_LENGTH);
}

// One end of an open channel: JSON in, sealed base64 out, and back. Holds
// both counters, starting at 0 — the first frame each way is the auth /
// connected exchange (handshake.cjs). `open` returns null for anything that
// is not the next frame, and the caller closes the connection on null.
function createChannelSession({ keys, role }) {
  const isPhone = role === 'phone';
  if (!isPhone && role !== 'mac') throw new Error(`Unknown role: ${role}`);
  const sendKey = isPhone ? keys.phoneToMacKey : keys.macToPhoneKey;
  const receiveKey = isPhone ? keys.macToPhoneKey : keys.phoneToMacKey;
  const sendDirection = isPhone ? 'phone-to-mac' : 'mac-to-phone';
  const receiveDirection = isPhone ? 'mac-to-phone' : 'phone-to-mac';
  let outCounter = 0;
  let inCounter = 0;
  return {
    seal(payload) {
      const frame = sealChannelFrame({
        payload: new TextEncoder().encode(JSON.stringify(payload)),
        key: sendKey,
        sessionId: keys.sessionId,
        direction: sendDirection,
        kind: 'text',
        counter: outCounter,
      });
      outCounter += 1;
      return encodeBase64(frame);
    },
    open(frameB64) {
      let frame;
      try {
        frame = decodeBase64(frameB64);
      } catch {
        return null;
      }
      const plaintext = openChannelFrame({
        frame,
        key: receiveKey,
        sessionId: keys.sessionId,
        direction: receiveDirection,
        kind: 'text',
        expectedCounter: inCounter,
      });
      if (!plaintext) return null;
      let payload;
      try {
        payload = JSON.parse(new TextDecoder().decode(plaintext));
      } catch {
        return null;
      }
      inCounter += 1;
      return payload;
    },
  };
}

module.exports = {
  FRAME_VERSION,
  HEADER_LENGTH,
  sealChannelFrame,
  openChannelFrame,
  createChannelSession,
};
