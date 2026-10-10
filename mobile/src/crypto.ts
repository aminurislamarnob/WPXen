// One-time process setup for everything tweetnacl: React Native ships no
// CSPRNG that tweetnacl finds on its own, so key generation throws ("no
// PRNG") until this runs. Backed by expo-crypto. Called once from the root
// layout before any pairing or channel code runs.

import nacl from 'tweetnacl';
import { getRandomValues } from 'expo-crypto';

let installed = false;

export function installSecureRandom(): void {
  if (installed) return;
  installed = true;
  nacl.setPRNG((output: Uint8Array, length: number) => {
    output.set(getRandomValues(new Uint8Array(length)));
  });
}
