'use strict';

// tweetnacl box keypairs. tweetnacl is pure JS, so this runs in React Native
// as well as Node — the one native dependency the shared module allows.

const nacl = require('tweetnacl');
const { encodeBase64 } = require('./base64.cjs');

function newKeyPair() {
  return nacl.box.keyPair();
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

module.exports = { newKeyPair, keyPairFromSecret, publicKeyB64, secretKeyB64 };
