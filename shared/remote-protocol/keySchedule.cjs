'use strict';

// Per-connection key schedule for the device channel (protocol v2). After
// Orca's mobile-e2ee-v2-node-key-schedule.ts and -contract.ts, with
// tweetnacl's SHA-512 (`nacl.hash`) in place of HKDF-SHA-256 so the module
// stays pure JS for React Native — no Node crypto, no extra dependency.
//
// Every connection mixes four secrets the two ends share and nobody on the
// path does:
//
//   staticShared     box.before(peer long-term public, own long-term secret)
//                    — only the paired phone and this Mac can compute it, so
//                    deriving the right keys *is* the authentication.
//   ephemeralShared  box.before(peer ephemeral public, own ephemeral secret)
//                    — fresh keypairs on both ends every connection, so a
//                    recording stays sealed even if a long-term key leaks
//                    later.
//   clientNonce, serverNonce  32 fresh bytes from each end.
//
// plus a hash of the transcript (every handshake field, labelled and length-
// prefixed so no two transcripts encode alike). The server's nonce is the
// replay guard: a hello copied onto a new socket meets a new serverNonce,
// derives keys its sender never had, and its auth frame cannot open.
//
//   material   = SHA-512(KEYS_LABEL ‖ staticShared ‖ ephemeralShared ‖
//                        clientNonce ‖ serverNonce ‖ transcriptHash)
//   phoneToMac = material[0..32)    macToPhone = material[32..64)
//   sessionId  = transcriptHash[0..32)
//
// One key per direction, so a frame reflected back at its sender never
// opens (channelFraming.cjs also seals the direction into each frame).

const nacl = require('tweetnacl');

// Domain labels. `wpxen`-prefixed protocol identifiers; they never leave the
// wire, but a rename that changes them is a protocol version bump.
const TRANSCRIPT_LABEL = 'wpxen-remote/v2/transcript';
const KEYS_LABEL = 'wpxen-remote/v2/keys';

const KEY_LENGTH = 32;
const NONCE_LENGTH = 32;

function utf8(text) {
  return new TextEncoder().encode(text);
}

function concatBytes(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function uint32(value) {
  const out = new Uint8Array(4);
  out[0] = (value >>> 24) & 0xff;
  out[1] = (value >>> 16) & 0xff;
  out[2] = (value >>> 8) & 0xff;
  out[3] = value & 0xff;
  return out;
}

function requireLength(bytes, length, label) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new Error(`Invalid ${label}: expected ${length} bytes.`);
  }
}

// Labelled, length-prefixed fields (after Orca's encodeMobileE2EEV2Transcript):
// label length ‖ label ‖ value length ‖ value, for each field in order.
function encodeFields(fields) {
  const parts = [];
  for (const [label, value] of fields) {
    const name = utf8(label);
    parts.push(uint32(name.length), name, uint32(value.length), value);
  }
  return concatBytes(parts);
}

function channelTranscript({
  version,
  deviceId,
  hostPublicKey,
  devicePublicKey,
  clientEphemeralKey,
  serverEphemeralKey,
  clientNonce,
  serverNonce,
}) {
  requireLength(hostPublicKey, KEY_LENGTH, 'host public key');
  requireLength(devicePublicKey, KEY_LENGTH, 'device public key');
  requireLength(clientEphemeralKey, KEY_LENGTH, 'client ephemeral key');
  requireLength(serverEphemeralKey, KEY_LENGTH, 'server ephemeral key');
  requireLength(clientNonce, NONCE_LENGTH, 'client nonce');
  requireLength(serverNonce, NONCE_LENGTH, 'server nonce');
  if (typeof deviceId !== 'string' || !deviceId) throw new Error('Invalid device id.');
  return encodeFields([
    ['domain', utf8(TRANSCRIPT_LABEL)],
    ['version', uint32(version)],
    ['device-id', utf8(deviceId)],
    ['host-public-key', hostPublicKey],
    ['device-public-key', devicePublicKey],
    ['client-ephemeral-key', clientEphemeralKey],
    ['server-ephemeral-key', serverEphemeralKey],
    ['client-nonce', clientNonce],
    ['server-nonce', serverNonce],
  ]);
}

// box.before: X25519 then HSalsa20, the same shared key nacl.box uses.
function sharedKey(ownSecretKey, peerPublicKey) {
  requireLength(ownSecretKey, KEY_LENGTH, 'secret key');
  requireLength(peerPublicKey, KEY_LENGTH, 'public key');
  return nacl.box.before(peerPublicKey, ownSecretKey);
}

function deriveChannelKeys({
  staticShared,
  ephemeralShared,
  clientNonce,
  serverNonce,
  transcript,
}) {
  requireLength(staticShared, KEY_LENGTH, 'static shared key');
  requireLength(ephemeralShared, KEY_LENGTH, 'ephemeral shared key');
  requireLength(clientNonce, NONCE_LENGTH, 'client nonce');
  requireLength(serverNonce, NONCE_LENGTH, 'server nonce');
  const transcriptHash = nacl.hash(transcript);
  const material = nacl.hash(
    concatBytes([
      utf8(KEYS_LABEL),
      staticShared,
      ephemeralShared,
      clientNonce,
      serverNonce,
      transcriptHash,
    ])
  );
  return {
    phoneToMacKey: material.slice(0, 32),
    macToPhoneKey: material.slice(32, 64),
    sessionId: transcriptHash.slice(0, 32),
    transcriptHash,
  };
}

module.exports = {
  TRANSCRIPT_LABEL,
  KEYS_LABEL,
  KEY_LENGTH,
  NONCE_LENGTH,
  concatBytes,
  channelTranscript,
  sharedKey,
  deriveChannelKeys,
};
