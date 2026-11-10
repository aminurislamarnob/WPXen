// One pairing attempt at a time, and only the latest one may touch the
// screen (after Orca e0b5a428527). The scanner reports a QR on several frames
// before React re-renders, so a busy flag read from state lets one scan start
// several pairings — each with its own keypair, so a later one can show a
// different 4-digit code than the Mac does, which is exactly the mismatch
// the code exists to catch. The guard is set synchronously, before the first
// await. Cancel aborts the running attempt (pairWithLink closes its socket),
// and an attempt that was cancelled or replaced reports nothing back. Pure,
// so it is tested.

export interface PairingAttempt {
  id: number;
  signal: AbortSignal;
}

export function createPairingAttempts() {
  let seq = 0;
  let current: { id: number; controller: AbortController } | null = null;
  return {
    // A new attempt, or null while one is already running.
    begin(): PairingAttempt | null {
      if (current) return null;
      seq += 1;
      current = { id: seq, controller: new AbortController() };
      return { id: current.id, signal: current.controller.signal };
    },
    // Whether this attempt is still the one the screen shows.
    isCurrent(id: number): boolean {
      return current?.id === id && !current.controller.signal.aborted;
    },
    // Ends an attempt; true only when it was still current, so its result
    // may be acted on (saved, shown).
    end(id: number): boolean {
      if (current?.id !== id) return false;
      const live = !current.controller.signal.aborted;
      current = null;
      return live;
    },
    // Cancel or leaving the screen.
    cancel(): void {
      if (!current) return;
      current.controller.abort();
      current = null;
    },
  };
}
