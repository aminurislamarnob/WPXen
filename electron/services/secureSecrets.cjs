'use strict';

// Encrypted secrets (spec #136): values that must never sit in the store in
// plain text — the Cloudflare tunnel token, later the Mac's key pair. The
// ciphertext (base64) lives in the store; the key lives in the macOS Keychain
// behind Electron safeStorage. `safeStorage` resolves lazily so tests import
// this module under plain Node; inject a fake through the call args.

function defaultSafeStorage() {
  try {
    return require('electron').safeStorage;
  } catch {
    return null;
  }
}

function checkAvailable(safeStorage) {
  if (!safeStorage || safeStorage.isEncryptionAvailable?.() !== true) {
    throw new Error('Secure storage is not available on this Mac right now.');
  }
}

function saveSecret({ store, safeStorage = defaultSafeStorage(), key, value }) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Enter a value before saving.');
  }
  checkAvailable(safeStorage);
  const cipher = safeStorage.encryptString(value);
  store.set(key, Buffer.from(cipher).toString('base64'));
}

function loadSecret({ store, safeStorage = defaultSafeStorage(), key }) {
  const raw = store.get(key, undefined);
  if (typeof raw !== 'string' || !raw) return null;
  checkAvailable(safeStorage);
  const plain = safeStorage.decryptString(Buffer.from(raw, 'base64'));
  return Buffer.from(plain).toString('utf8');
}

function hasSecret({ store, key }) {
  const raw = store.get(key, undefined);
  return typeof raw === 'string' && raw.length > 0;
}

function clearSecret({ store, key }) {
  store.delete(key);
}

module.exports = { saveSecret, loadSecret, hasSecret, clearSecret };
