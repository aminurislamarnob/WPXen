'use strict';

// Device and host box keypairs. tweetnacl is pure JS, so this runs in React
// Native as well as Node — the one native dependency the shared module allows.
//
// Randomness comes from the caller (after Orca's paired-e2ee-primitives.ts):
// every function here and in the client that draws random bytes takes a
// `randomBytes(length) => Uint8Array`. The Mac hands in Node's crypto, the
// phone expo-crypto (mobile/src/crypto.ts). Without one, tweetnacl's own is
// used — it finds a CSPRNG on Node and in browsers, but on React Native only
// once one is installed into the very same module instance.

const nacl = require('tweetnacl');
const { encodeBase64 } = require('./base64.cjs');

function defaultRandomBytes(length) {
  return nacl.randomBytes(length);
}

// The caller's source, checked: a short or non-byte answer would quietly
// shrink a key or a nonce.
function drawRandom(randomBytes, length) {
  const out = (randomBytes || defaultRandomBytes)(length);
  if (!(out instanceof Uint8Array) || out.length !== length) {
    throw new Error(`randomBytes(${length}) must return ${length} bytes.`);
  }
  return out;
}

function newKeyPair(randomBytes) {
  return nacl.box.keyPair.fromSecretKey(
    drawRandom(randomBytes, nacl.box.secretKeyLength)
  );
}

// Rebuild the pair from a stored secret. The public half is always derived
// from the secret (after Orca e2ee-keypair.ts): advertising a stored public
// key that disagrees with the secret would offer a key no listener holds.
function keyPairFromSecret(secretKey) {
  return nacl.box.keyPair.fromSecretKey(secretKey);
}

function publicKeyB64(keyPair) {
  return encodeBase64(keyPair.publicKey);
}

function secretKeyB64(keyPair) {
  return encodeBase64(keyPair.secretKey);
}

module.exports = {
  drawRandom,
  newKeyPair,
  keyPairFromSecret,
  publicKeyB64,
  secretKeyB64,
};
