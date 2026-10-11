'use strict';

// Pairing offer URL and handshake codecs. The QR encodes a URL carrying
// everything the phone needs to open the pairing request: the protocol
// version, the host identity, the Mac's public key, the wss:// address and
// the one-time secret. URLSearchParams (not querystring) so React Native can
// run this file unchanged.

const { confirmationCode } = require('./confirm.cjs');
const { sealFrame, openFrame, randomNonce } = require('./frames.cjs');
const { encodeBase64 } = require('./base64.cjs');

const PAIRING_SCHEME = 'wpxen://pair';

function pairingUrl({ version, hostId, hostPublicKeyB64, secret, wssUrl }) {
  const params = new URLSearchParams({
    v: String(version),
    host: hostId,
    key: hostPublicKeyB64,
    secret,
    url: wssUrl,
  });
  return `${PAIRING_SCHEME}?${params.toString()}`;
}

function parsePairingUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('Not a pairing URL.');
  }
  if (`${url.protocol}//${url.host}` !== PAIRING_SCHEME) {
    throw new Error('Not a pairing URL.');
  }
  const out = {
    version: Number(url.searchParams.get('v')),
    hostId: url.searchParams.get('host') || '',
    hostPublicKeyB64: url.searchParams.get('key') || '',
    secret: url.searchParams.get('secret') || '',
    wssUrl: url.searchParams.get('url') || '',
  };
  if (!out.hostId || !out.hostPublicKeyB64 || !out.secret || !out.wssUrl) {
    throw new Error('The pairing URL is missing fields.');
  }
  return out;
}

// The phone's opening message. The device public key rides in the clear; the
// secret rides sealed inside, so only the Mac can read it. The confirmation
// code binds both keys plus the secret — returned here so the phone can show
// it, and derived independently by the Mac for the Allow/Deny dialog.
function createPairRequest({
  secret,
  deviceName,
  platform,
  keys,
  hostPublicKey,
  version,
}) {
  const sealed = sealFrame({
    payload: {
      kind: 'pair-request',
      version,
      secret,
      deviceName,
      platform,
      devicePublicKey: encodeBase64(keys.publicKey),
    },
    senderSecret: keys.secretKey,
    recipientPublicKey: hostPublicKey,
    nonce: randomNonce(),
  });
  return {
    message: {
      v: version,
      type: 'pair-request',
      devicePublicKey: encodeBase64(keys.publicKey),
      nonce: sealed.nonce,
      box: sealed.box,
    },
    code: confirmationCode(
      encodeBase64(hostPublicKey),
      encodeBase64(keys.publicKey),
      secret
    ),
  };
}

// Open the Mac's accept reply. Throws when the reply is a rejection or fails
// to open — the caller tells those apart by the message type first.
function openPairAccept({ message, keys, hostPublicKey }) {
  const payload = openFrame({
    nonce: message.nonce,
    box: message.box,
    senderPublicKey: hostPublicKey,
    recipientSecret: keys.secretKey,
  });
  if (
    !payload ||
    payload.kind !== 'pair-accept' ||
    typeof payload.deviceId !== 'string'
  ) {
    throw new Error('Not a pairing accept.');
  }
  return { deviceId: payload.deviceId, code: payload.code };
}

module.exports = {
  PAIRING_SCHEME,
  pairingUrl,
  parsePairingUrl,
  createPairRequest,
  openPairAccept,
};
