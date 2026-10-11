import { describe, expect, it } from 'vitest';
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, backoffDelayMs } from './backoff';

describe('backoffDelayMs', () => {
  it('starts at the base and doubles per attempt', () => {
    expect(backoffDelayMs(0, () => 1)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelayMs(1, () => 1)).toBe(BACKOFF_BASE_MS * 2);
    expect(backoffDelayMs(2, () => 1)).toBe(BACKOFF_BASE_MS * 4);
  });

  it('caps instead of growing forever', () => {
    expect(backoffDelayMs(20, () => 1)).toBe(BACKOFF_CAP_MS);
    expect(backoffDelayMs(100, () => 1)).toBe(BACKOFF_CAP_MS);
  });

  it('jitters the full range down to zero', () => {
    expect(backoffDelayMs(3, () => 0)).toBe(0);
    expect(backoffDelayMs(3, () => 0.5)).toBe(Math.floor(BACKOFF_BASE_MS * 8 * 0.5));
  });

  it('treats a negative attempt as the first', () => {
    expect(backoffDelayMs(-1, () => 1)).toBe(BACKOFF_BASE_MS);
  });
});
