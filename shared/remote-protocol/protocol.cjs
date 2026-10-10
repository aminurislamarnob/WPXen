'use strict';

// Protocol identity. Phone and desktop compare versions on every handshake.

const PROTOCOL_VERSION = 1;

// The one unauthenticated route on the localhost server. `wpxen`-prefixed so
// a future rename can find it next to any LEGACY_* list it may one day join.
const HEALTH_PATH = '/wpxen-health';

// WebSocket upgrades only happen here; every other upgrade is refused. The
// phone dials it as wss://<hostname>/wpxen-device through the tunnel.
const DEVICE_PATH = '/wpxen-device';

// Application close codes (4000–4999): a revoked phone reads `revoked` off
// the shared client half; disconnect-all is an ordinary close that may
// reconnect.
const CLOSE_REVOKED = 4401;
const CLOSE_DISCONNECT_ALL = 4402;

module.exports = {
  PROTOCOL_VERSION,
  HEALTH_PATH,
  DEVICE_PATH,
  CLOSE_REVOKED,
  CLOSE_DISCONNECT_ALL,
};
