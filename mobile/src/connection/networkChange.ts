// Whether a network change should nudge the connection to redial now rather
// than wait out its backoff (after Orca's connection-revival-triggers.ts):
// coming back online, or a Wi-Fi ↔ cellular handoff, which can kill the TCP
// connection while "connected" stays true. Pure, so it is tested; the
// expo-network listener lives in revival.ts.

export interface NetworkSnapshot {
  isConnected: boolean | undefined;
  type: string | undefined;
}

export function networkChangeNudges(previous: NetworkSnapshot | null, next: NetworkSnapshot): boolean {
  if (next.isConnected !== true) return false;
  const cameOnline = previous != null && previous.isConnected !== true;
  const switchedNetworks = previous?.type != null && next.type !== previous.type;
  return cameOnline || switchedNetworks;
}
