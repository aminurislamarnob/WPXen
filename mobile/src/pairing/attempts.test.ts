import { describe, expect, it } from 'vitest';
import { createPairingAttempts } from './attempts';

describe('pairing attempts', () => {
  it('starts one attempt for scans that land in the same tick', () => {
    const attempts = createPairingAttempts();
    // Three frames of the same QR, before any re-render.
    const first = attempts.begin();
    expect(first).not.toBeNull();
    expect(attempts.begin()).toBeNull();
    expect(attempts.begin()).toBeNull();
    expect(attempts.isCurrent(first!.id)).toBe(true);
  });

  it('allows a new attempt once the last one ended', () => {
    const attempts = createPairingAttempts();
    const first = attempts.begin()!;
    expect(attempts.end(first.id)).toBe(true);
    const second = attempts.begin()!;
    expect(second.id).not.toBe(first.id);
  });

  it('cancel aborts the running attempt and silences its result', () => {
    const attempts = createPairingAttempts();
    const attempt = attempts.begin()!;
    attempts.cancel();
    expect(attempt.signal.aborted).toBe(true);
    expect(attempts.isCurrent(attempt.id)).toBe(false);
    // The late result of a cancelled attempt is not acted on.
    expect(attempts.end(attempt.id)).toBe(false);
  });

  it('an attempt replaced after a cancel cannot end the new one', () => {
    const attempts = createPairingAttempts();
    const old = attempts.begin()!;
    attempts.cancel();
    const next = attempts.begin()!;
    expect(attempts.end(old.id)).toBe(false);
    expect(attempts.isCurrent(next.id)).toBe(true);
  });
});
