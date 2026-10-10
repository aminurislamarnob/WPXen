'use strict';

// WPXen Mobile ↔ desktop shared protocol (spec #136).
//
// Plain JavaScript with JSDoc types and no Node-only or Electron APIs, so both
// the Electron main process (via require) and the React Native phone app (via
// Metro) import the same framing, names and versions. Desktop CI does not lint,
// format-check, test or build `mobile/`; this folder stays in the root
// eslint/prettier run so drift fails here, not on the phone.
//
// The frame format is documented in frames.cjs. Only tweetnacl plus the local
// base64 helper are allowed here — no Buffer, crypto, atob or WebSocket.

const { PROTOCOL_VERSION, HEALTH_PATH, DEVICE_PATH } = require('./protocol.cjs');
const { encodeBase64, decodeBase64 } = require('./base64.cjs');
const {
  newKeyPair,
  keyPairFromSecret,
  publicKeyB64,
  secretKeyB64,
} = require('./keys.cjs');
const { confirmationCode } = require('./confirm.cjs');
const { PAIR_ERRORS } = require('./errors.cjs');
const { randomNonce, sealFrame, openFrame } = require('./frames.cjs');
const {
  PAIRING_SCHEME,
  pairingUrl,
  parsePairingUrl,
  createPairRequest,
  openPairAccept,
} = require('./pairing.cjs');
const { createClient, DEFAULT_REQUEST_TIMEOUT_MS } = require('./client.cjs');

module.exports = {
  PROTOCOL_VERSION,
  HEALTH_PATH,
  DEVICE_PATH,
  encodeBase64,
  decodeBase64,
  newKeyPair,
  keyPairFromSecret,
  publicKeyB64,
  secretKeyB64,
  confirmationCode,
  PAIR_ERRORS,
  randomNonce,
  sealFrame,
  openFrame,
  PAIRING_SCHEME,
  pairingUrl,
  parsePairingUrl,
  createPairRequest,
  openPairAccept,
  createClient,
  DEFAULT_REQUEST_TIMEOUT_MS,
};
