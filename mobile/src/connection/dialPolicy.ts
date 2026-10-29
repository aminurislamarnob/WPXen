// What a failed dial means for the next one. Most failures are transient
// and the loop backs off and retries; some the Mac states outright, and
// retrying them only burns battery and hides the real problem behind
// "Reconnecting…". Those latch: the loop stops and the screen says what to do.

export type DialFailure =
  | { code: 'version_mismatch'; update: 'desktop' | 'phone' }
  | { code: 'revoked' }
  | { code: 'unreachable' };

export type ConnectionLatch =
  | { kind: 'update-required'; update: 'desktop' | 'phone' }
  | { kind: 'auth-failed' };

// Refusals with the revoked code in a row before the pairing is declared
// invalid (after Orca's direct-rpc-client.ts authentication retry): one
// refusal could be a Mac mid-restore, three is the Mac saying so.
export const AUTH_REFUSALS_TO_LATCH = 3;

export type DialVerdict = { action: 'retry' } | { action: 'latch'; latch: ConnectionLatch };

// The rejected connect()'s error, as the shared client names it (DIAL_ERRORS).
export function readDialFailure(err: unknown): DialFailure {
  const e = err as { code?: unknown; update?: unknown } | null;
  if (e && e.code === 'version_mismatch') {
    return { code: 'version_mismatch', update: e.update === 'desktop' ? 'desktop' : 'phone' };
  }
  if (e && e.code === 'revoked') return { code: 'revoked' };
  return { code: 'unreachable' };
}

// `refusals` counts revoked-code refusals in a row; any other outcome
// (including a successful connect, which the caller handles) resets it.
export function judgeDialFailure(
  failure: DialFailure,
  refusals = 0
): { verdict: DialVerdict; refusals: number } {
  // A version mismatch never fixes itself by redialling.
  if (failure.code === 'version_mismatch') {
    return {
      verdict: { action: 'latch', latch: { kind: 'update-required', update: failure.update } },
      refusals: 0,
    };
  }
  if (failure.code === 'revoked') {
    const next = refusals + 1;
    return next >= AUTH_REFUSALS_TO_LATCH
      ? { verdict: { action: 'latch', latch: { kind: 'auth-failed' } }, refusals: next }
      : { verdict: { action: 'retry' }, refusals: next };
  }
  return { verdict: { action: 'retry' }, refusals: 0 };
}
