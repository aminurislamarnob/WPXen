// Keeps OS-signal probes of an open socket to one at a time and a few
// seconds apart (after Orca's rpc-session-liveness-watchdog.ts,
// 0a75796a038). A probe is one short ping that closes the socket on a miss;
// a burst of network events (roaming fires several) must not stack probes or
// re-probe a link that just proved itself. A return from the background
// skips the spacing — the stay invalidates earlier evidence — but still
// waits for a probe already running. Pure, so it is tested.

export const PROBE_MIN_INTERVAL_MS = 5_000;

export function createProbeGate({
  now = Date.now,
  minIntervalMs = PROBE_MIN_INTERVAL_MS,
}: { now?: () => number; minIntervalMs?: number } = {}) {
  let inFlight = false;
  let lastStartedAt: number | null = null;
  return {
    // Whether a probe may start now; marks it running when it may.
    tryStart({ afterBackground = false }: { afterBackground?: boolean } = {}): boolean {
      if (inFlight) return false;
      const t = now();
      if (!afterBackground && lastStartedAt !== null && t - lastStartedAt < minIntervalMs) return false;
      inFlight = true;
      lastStartedAt = t;
      return true;
    },
    finish(): void {
      inFlight = false;
    },
    // A new socket: nothing learned about the old one applies.
    reset(): void {
      inFlight = false;
      lastStartedAt = null;
    },
  };
}
