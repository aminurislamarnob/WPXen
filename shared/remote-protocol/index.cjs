'use strict';

// WPXen Mobile ↔ desktop shared protocol (spec #136).
//
// Plain JavaScript with JSDoc types and no Node-only or Electron APIs in this
// half, so both the Electron main process (via require) and the React Native
// phone app (via Metro) import the same framing, names and versions. Desktop
// CI does not lint, format-check, test or build `mobile/`; this folder stays
// in the root eslint/prettier run so drift fails here, not on the phone.

/**
 * A health-check answer from the desktop Remote Access server.
 *
 * @typedef {object} HealthResponse
 * @property {string} nonce the caller's `nonce` query parameter, echoed back
 * @property {string} hostId this Mac's stable identity (created once, stored)
 * @property {number} protocolVersion PROTOCOL_VERSION below
 */

// Every frame the phone and the Mac exchange carries this. A mismatch fails
// with a reason naming which side to update, never silently.
const PROTOCOL_VERSION = 1;

// The one unauthenticated route on the localhost server. `wpxen`-prefixed so
// a future rename can find it next to any LEGACY_* list it may one day join.
const HEALTH_PATH = '/wpxen-health';

module.exports = { PROTOCOL_VERSION, HEALTH_PATH };
