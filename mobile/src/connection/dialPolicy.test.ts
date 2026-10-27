import { describe, expect, it } from 'vitest';
import { judgeDialFailure, readDialFailure } from './dialPolicy';

describe('dial failures', () => {
  it('latches a version mismatch, naming the side to update', () => {
    const err = Object.assign(new Error('Version mismatch.'), { code: 'version_mismatch', update: 'desktop' });
    expect(judgeDialFailure(readDialFailure(err))).toEqual({
      action: 'latch',
      latch: { kind: 'update-required', update: 'desktop' },
    });
    const phone = Object.assign(new Error('x'), { code: 'version_mismatch', update: 'nonsense' });
    expect(judgeDialFailure(readDialFailure(phone))).toMatchObject({ latch: { update: 'phone' } });
  });

  it('retries anything it cannot name', () => {
    for (const err of [new Error('Could not connect.'), null, { code: 'unreachable' }, 'boom']) {
      expect(judgeDialFailure(readDialFailure(err))).toEqual({ action: 'retry' });
    }
  });
});
