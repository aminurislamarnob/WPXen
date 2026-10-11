'use strict';

// Error codes both sides name. Reject reasons travel in plaintext (they carry
// no secrets); anything encrypted failing to open closes the socket instead.

const PAIR_ERRORS = {
  versionMismatch: 'version_mismatch',
  pairingExpired: 'pairing_expired',
  pairingUsed: 'pairing_used',
  pairingDenied: 'pairing_denied',
  pairingTimeout: 'pairing_timeout',
  invalidSecret: 'invalid_secret',
  rateLimited: 'rate_limited',
  opNotAllowed: 'op_not_allowed',
};

module.exports = { PAIR_ERRORS };
