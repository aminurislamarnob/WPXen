'use strict';

// Sealed frames. Every encrypted byte between phone and Mac is a tweetnacl
// box; Cloudflare only ever carries ciphertext.
//
// Wire format (outer JSON, plaintext fields only):
//
//   { v, deviceId?, counter, nonce, box }
//
//   v         protocol version (a mismatch closes the socket)
//   deviceId  the paired device, client → server only
//   counter   monotonically increasing per direction, per connection,
//             starting at 1. Anything else (replay, reorder, gap) closes it.
//   nonce     24 fresh random bytes, base64
//   box       base64 box(payloadJSON, nonce, recipientPub, senderSecret)
//
// Box payloads are JSON with a `kind`: 'pair-request' | 'pair-accept' |
// 'hello' | 'request' | 'response' | 'event'. Plaintext rejections
// ({ type: 'pair-reject', reason }) carry no secrets.
//
// The plaintext envelope authenticates nothing, so a device channel binds
// every sealed payload to its connection (after Orca's mobile E2EE v2, which
// seals the session id, direction and counter inside each frame):
//
//   1. The phone's first frame is { kind: 'hello', n: 1, clientNonce }.
//   2. The Mac answers with the 'connected' event carrying
//      ch: '<clientNonce>.<serverNonce>' — fresh randomness from each side.
//   3. Every later payload, both ways, carries that `ch` and `n` equal to
//      the envelope's counter; anything else closes the socket.
//
// So a frame captured off the wire is worthless anywhere else: replayed on a
// new connection its `ch` names the old one, and inside its own connection
// its sealed `n` pins its position. Counters restart per connection.
//
// React Native safe: tweetnacl plus the local base64 helper only — no
// Buffer, crypto, atob or WebSocket here. Strings cross the box boundary as
// UTF-8 via TextEncoder/TextDecoder, which Node, browsers and React Native
// all provide.

const nacl = require('tweetnacl');
const { encodeBase64, decodeBase64 } = require('./base64.cjs');
const { drawRandom } = require('./keys.cjs');

function encodeUtf8(text) {
  return new TextEncoder().encode(text);
}

function decodeUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}

// `randomBytes` is the caller's source (see keys.cjs).
function randomNonce(randomBytes) {
  return drawRandom(randomBytes, nacl.box.nonceLength);
}

function sealFrame({ payload, senderSecret, recipientPublicKey, nonce = randomNonce() }) {
  const box = nacl.box(
    encodeUtf8(JSON.stringify(payload)),
    nonce,
    recipientPublicKey,
    senderSecret
  );
  return { nonce: encodeBase64(nonce), box: encodeBase64(box) };
}

function openFrame({ nonce, box, senderPublicKey, recipientSecret }) {
  const opened = nacl.box.open(
    decodeBase64(box),
    decodeBase64(nonce),
    senderPublicKey,
    recipientSecret
  );
  if (!opened) throw new Error('Could not open the frame.');
  return JSON.parse(decodeUtf8(opened));
}

module.exports = { randomNonce, sealFrame, openFrame };
