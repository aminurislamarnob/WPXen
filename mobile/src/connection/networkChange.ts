// Whether a network change should nudge the connection (after Orca's
// connection-revival-triggers.ts, 0a75796a038): every event that reports the
// phone connected. Wi-Fi roaming, a new access point or a VPN coming up can
// replace the TCP path without changing the reported type, so comparing
// types misses exactly the handoffs that leave a socket open but dead. The
// nudge is cheap: a down connection redials, an open one probes, and the
// probe gate (probeGate.ts) keeps a burst of events to one probe. Pure, so it
// is tested; the expo-network listener lives in revival.ts.

export interface NetworkSnapshot {
  isConnected: boolean | undefined;
  type: string | undefined;
}

export function networkChangeNudges(next: NetworkSnapshot): boolean {
  return next.isConnected === true;
}
