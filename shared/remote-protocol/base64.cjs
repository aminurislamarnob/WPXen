'use strict';

// Self-contained base64 over Uint8Array. The shared module runs in React
// Native too, so no Buffer, atob or btoa — those differ per platform.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? ALPHABET[n & 63] : '=';
  }
  return out;
}

function decodeBase64(text) {
  if (typeof text !== 'string' || /[^A-Za-z0-9+/=]/.test(text) || text.length % 4 !== 0) {
    throw new Error('Not base64.');
  }
  const lookup = {};
  for (let i = 0; i < ALPHABET.length; i++) lookup[ALPHABET[i]] = i;
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let j = 0;
  for (let i = 0; i < text.length; i += 4) {
    const n =
      (lookup[text[i]] << 18) |
      (lookup[text[i + 1]] << 12) |
      ((text[i + 2] === '=' ? 0 : lookup[text[i + 2]]) << 6) |
      (text[i + 3] === '=' ? 0 : lookup[text[i + 3]]);
    out[j++] = (n >> 16) & 255;
    if (text[i + 2] !== '=') out[j++] = (n >> 8) & 255;
    if (text[i + 3] !== '=') out[j++] = n & 255;
  }
  return out;
}

module.exports = { encodeBase64, decodeBase64 };
