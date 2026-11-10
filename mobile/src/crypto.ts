// The phone's CSPRNG, backed by expo-crypto. React Native ships none that
// tweetnacl finds on its own.
//
// The shared protocol takes its randomness from its caller (see
// shared/remote-protocol/keys.cjs), so pairing and the channel pass
// `secureRandomBytes` explicitly. installSecureRandom() additionally wires
// it into tweetnacl itself, for anything that still reaches nacl's own
// randomBytes; Metro maps shared/'s tweetnacl onto this same copy
// (metro.config.js), so both see one PRNG. Called once from the root layout.

import nacl from 'tweetnacl';
import { getRandomValues } from 'expo-crypto';

export function secureRandomBytes(length: number): Uint8Array {
  return getRandomValues(new Uint8Array(length));
}

let installed = false;

export function installSecureRandom(): void {
  if (installed) return;
  installed = true;
  nacl.setPRNG((output: Uint8Array, length: number) => {
    output.set(secureRandomBytes(length));
  });
}
