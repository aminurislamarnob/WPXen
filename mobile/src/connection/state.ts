// Connection-state derivation: one pure function maps the socket, the last
// close, the heartbeat and the last contact onto the five states the UI
// shows. Centralized so every screen says the same thing (after Orca's
// connection-health verdicts, minus the relay-specific branches we lack).

export type ConnectionState = 'connected' | 'reconnecting' | 'offline' | 'asleep' | 'revoked';

export interface ConnectionSnapshot {
  socket: 'open' | 'connecting' | 'closed';
  closeStatus: 'revoked' | 'closed' | null;
  lastSeenAt: number | null;
  // Pings go unanswered although the socket looks open, or the socket died
  // without a close frame (backgrounding, sleep): the Mac is unreachable
  // but nothing said goodbye, which reads as asleep rather than offline.
  heartbeatLost: boolean;
}

export function deriveConnectionState(snap: ConnectionSnapshot): ConnectionState {
  // Revocation sticks: the Mac removed this device, so retrying is pointless.
  if (snap.closeStatus === 'revoked') return 'revoked';
  if (snap.socket === 'open') return snap.heartbeatLost ? 'asleep' : 'connected';
  if (snap.heartbeatLost) return 'asleep';
  if (snap.lastSeenAt != null) return 'offline';
  return 'reconnecting';
}
