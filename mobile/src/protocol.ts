// The shared phone/desktop protocol, imported from the repo — never copied
// into mobile/. TypeScript reads it through allowJs (see tsconfig); the
// desktop vitest suite pins its behaviour.

import {
  PROTOCOL_VERSION,
  DEVICE_PATH,
  PAIR_ERRORS,
  newKeyPair,
  publicKeyB64,
  encodeBase64,
  decodeBase64,
  parsePairingUrl,
  createPairRequest,
  openPairAccept,
  confirmationCode,
  createClient,
} from '../../shared/remote-protocol/index.cjs';

export {
  PROTOCOL_VERSION,
  DEVICE_PATH,
  PAIR_ERRORS,
  newKeyPair,
  publicKeyB64,
  encodeBase64,
  decodeBase64,
  parsePairingUrl,
  createPairRequest,
  openPairAccept,
  confirmationCode,
  createClient,
};
