'use strict';

// Long-term boxes: pairing only. Every encrypted byte between phone and Mac
// is tweetnacl; Cloudflare only ever carries ciphertext.
//
// What is on the wire (outer JSON; only these fields are plaintext):
//
//   Pairing, one socket, before the phone has a device id (pairing.cjs):
//     { v, type: 'pair-request', devicePublicKey, nonce, box }
//     { type: 'pair-accept', deviceId, code, nonce, box }
//     { type: 'pair-reject', reason, update? }        — carries no secrets
//   `box` here is nacl.box under the two long-term keys with a random nonce
//   (sealFrame / openFrame below). A captured request is useless again: the
//   one-time pairing secret inside it dies on first use.
//
//   Device channel, every later socket (handshake.cjs, channelFraming.cjs):
//     { v, type: 'hello', deviceId, clientNonce, ephemeralKey }
//     { v, type: 'ready', serverNonce, ephemeralKey }
//     { v, frame }   — both ways, from then on
//   `frame` is nacl.secretbox under a key derived for this connection alone
//   (keySchedule.cjs), one key per direction. Its nonce is not random: it is
//   the session id, direction, kind and counter, which the receiver
//   recomputes from what it expects next and then checks against the
//   sealed header byte for byte. The phone's frame 0 is its auth; the
//   Mac's is the 'connected' event. A frame replayed, skipped, reflected,
//   misread as another kind or moved to another connection doesn't open,
//   and a frame that doesn't open closes the socket.
//
// Sealed payloads are JSON with a `kind`: 'pair-request' | 'pair-accept'
// in boxes; 'auth' | 'request' | 'response' | 'event' in channel frames.
//
// React Native safe: tweetnacl plus the local helpers only — no Buffer,
// crypto, atob or WebSocket here. Strings cross the box boundary as UTF-8
// via TextEncoder/TextDecoder, which Node, browsers and React Native all
// provide.

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
