// What a failed dial means for the next one. Most failures are transient
// and the loop backs off and retries; some the Mac states outright, and
// retrying them only burns battery and hides the real problem behind
// "Reconnecting…". Those latch: the loop stops and the screen says what to do.

export type DialFailure =
  | { code: 'version_mismatch'; update: 'desktop' | 'phone' }
  | { code: 'unreachable' };

export type ConnectionLatch = { kind: 'update-required'; update: 'desktop' | 'phone' };

export type DialVerdict = { action: 'retry' } | { action: 'latch'; latch: ConnectionLatch };

// The rejected connect()'s error, as the shared client names it (DIAL_ERRORS).
export function readDialFailure(err: unknown): DialFailure {
  const e = err as { code?: unknown; update?: unknown } | null;
  if (e && e.code === 'version_mismatch') {
    return { code: 'version_mismatch', update: e.update === 'desktop' ? 'desktop' : 'phone' };
  }
  return { code: 'unreachable' };
}

export function judgeDialFailure(failure: DialFailure): DialVerdict {
  // A version mismatch never fixes itself by redialling.
  if (failure.code === 'version_mismatch') {
    return { action: 'latch', latch: { kind: 'update-required', update: failure.update } };
  }
  return { action: 'retry' };
}
