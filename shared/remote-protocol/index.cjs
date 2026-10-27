'use strict';

// WPXen Mobile ↔ desktop shared protocol (spec #136).
//
// Plain JavaScript with JSDoc types and no Node-only or Electron APIs, so both
// the Electron main process (via require) and the React Native phone app (via
// Metro) import the same framing, names and versions. This folder stays in the
// root eslint/prettier/vitest run so drift fails there, and CI's mobile job
// bundles it through Metro (`npm run bundle:check` in mobile/).
//
// The wire format is documented in frames.cjs; the channel handshake in
// handshake.cjs, its keys in keySchedule.cjs, its frames in channelFraming.cjs. Only tweetnacl plus the local
// base64 helper are allowed here — no Buffer, crypto, atob or WebSocket.

const {
  PROTOCOL_VERSION,
  HEALTH_PATH,
  DEVICE_PATH,
  CLOSE_REVOKED,
  CLOSE_DISCONNECT_ALL,
} = require('./protocol.cjs');
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
const { channelTranscript, sharedKey, deriveChannelKeys } = require('./keySchedule.cjs');
const {
  sealChannelFrame,
  openChannelFrame,
  createChannelSession,
} = require('./channelFraming.cjs');
const {
  createHello,
  parseHello,
  acceptHello,
  completeHandshake,
  authPayload,
  isAuthPayload,
} = require('./handshake.cjs');
const { createClient, DEFAULT_REQUEST_TIMEOUT_MS } = require('./client.cjs');

module.exports = {
  PROTOCOL_VERSION,
  HEALTH_PATH,
  DEVICE_PATH,
  CLOSE_REVOKED,
  CLOSE_DISCONNECT_ALL,
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
  channelTranscript,
  sharedKey,
  deriveChannelKeys,
  sealChannelFrame,
  openChannelFrame,
  createChannelSession,
  createHello,
  parseHello,
  acceptHello,
  completeHandshake,
  authPayload,
  isAuthPayload,
  createClient,
  DEFAULT_REQUEST_TIMEOUT_MS,
};
