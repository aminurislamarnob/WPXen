'use strict';

// The 4-digit pairing confirmation code. Both sides derive it from the same
// transcript — both public keys plus the one-time secret — and the human
// compares them. A MITM that swaps either public key computes a different
// code, which is what makes the swap visible. Pure JS (FNV-1a), so it runs
// identically on Node and React Native.

function confirmationCode(hostPublicKeyB64, devicePublicKeyB64, secret) {
  const [a, b] = [hostPublicKeyB64, devicePublicKeyB64].sort();
  const text = `${a}|${b}|${secret}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return String((hash >>> 0) % 10000).padStart(4, '0');
}

module.exports = { confirmationCode };
