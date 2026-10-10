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
// 'request' | 'response' | 'event'. Plaintext rejections
// ({ type: 'pair-reject', reason }) carry no secrets.
//
// React Native safe: tweetnacl plus the local base64 helper only — no
// Buffer, crypto, atob or WebSocket here. Strings cross the box boundary as
// UTF-8 via TextEncoder/TextDecoder, which Node, browsers and React Native
// all provide.

const nacl = require('tweetnacl');
const { encodeBase64, decodeBase64 } = require('./base64.cjs');

function encodeUtf8(text) {
  return new TextEncoder().encode(text);
}

function decodeUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}

function randomNonce() {
  return nacl.randomBytes(nacl.box.nonceLength);
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
