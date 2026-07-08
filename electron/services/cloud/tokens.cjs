'use strict';

// OAuth token persistence. Tokens are encrypted with Electron's safeStorage
// (macOS Keychain-backed) and stored base64 in the JSON store — never
// plaintext. On keychain-less setups where safeStorage is unavailable we
// refuse to connect rather than degrade to plaintext.

function getSafeStorage() {
  const { safeStorage } = require('electron');
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'Secure token storage is unavailable on this system, so cloud accounts cannot be connected.'
    );
  }
  return safeStorage;
}

function tokensKey(providerId) {
  return `settings.cloud.${providerId}.tokens`;
}

function saveTokens(store, providerId, tokens) {
  const enc = getSafeStorage().encryptString(JSON.stringify(tokens));
  store.set(tokensKey(providerId), enc.toString('base64'));
}

function loadTokens(store, providerId) {
  const b64 = store.get(tokensKey(providerId), null);
  if (!b64) return null;
  try {
    const raw = getSafeStorage().decryptString(Buffer.from(b64, 'base64'));
    return JSON.parse(raw);
  } catch {
    // Undecryptable (keychain reset, corrupt value) — treat as disconnected.
    return null;
  }
}

function clearTokens(store, providerId) {
  store.delete(tokensKey(providerId));
}

function hasTokens(store, providerId) {
  return !!store.get(tokensKey(providerId), null);
}

module.exports = { saveTokens, loadTokens, clearTokens, hasTokens };
