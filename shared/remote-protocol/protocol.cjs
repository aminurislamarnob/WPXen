'use strict';

// Protocol identity. Phone and desktop compare versions on every handshake.

const PROTOCOL_VERSION = 1;

// The one unauthenticated route on the localhost server. `wpxen`-prefixed so
// a future rename can find it next to any LEGACY_* list it may one day join.
const HEALTH_PATH = '/wpxen-health';

// WebSocket upgrades only happen here; every other upgrade is refused. The
// phone dials it as wss://<hostname>/wpxen-device through the tunnel.
const DEVICE_PATH = '/wpxen-device';

module.exports = { PROTOCOL_VERSION, HEALTH_PATH, DEVICE_PATH };
