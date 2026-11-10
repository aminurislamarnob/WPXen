import { describe, expect, it } from 'vitest';
import { AUTH_REFUSALS_TO_LATCH, judgeDialFailure, readDialFailure } from './dialPolicy';

describe('dial failures', () => {
  it('latches a version mismatch, naming the side to update', () => {
    const err = Object.assign(new Error('Version mismatch.'), { code: 'version_mismatch', update: 'desktop' });
    expect(judgeDialFailure(readDialFailure(err)).verdict).toEqual({
      action: 'latch',
      latch: { kind: 'update-required', update: 'desktop' },
    });
    const phone = Object.assign(new Error('x'), { code: 'version_mismatch', update: 'nonsense' });
    expect(judgeDialFailure(readDialFailure(phone)).verdict).toMatchObject({ latch: { update: 'phone' } });
  });

  it('retries anything it cannot name', () => {
    for (const err of [new Error('Could not connect.'), null, { code: 'unreachable' }, 'boom']) {
      expect(judgeDialFailure(readDialFailure(err)).verdict).toEqual({ action: 'retry' });
    }
  });

  it('latches auth-failed after three revoked refusals in a row, not before', () => {
    const revoked = Object.assign(new Error('Could not connect.'), { code: 'revoked' });
    let refusals = 0;
    const verdicts = [];
    for (let i = 0; i < AUTH_REFUSALS_TO_LATCH; i++) {
      const judged = judgeDialFailure(readDialFailure(revoked), refusals);
      refusals = judged.refusals;
      verdicts.push(judged.verdict.action);
    }
    expect(verdicts).toEqual(['retry', 'retry', 'latch']);
    expect(judgeDialFailure(readDialFailure(revoked), 2).verdict).toEqual({
      action: 'latch',
      latch: { kind: 'auth-failed' },
    });
  });

  it('an unreachable dial in between resets the count', () => {
    const revoked = { code: 'revoked' };
    let { refusals } = judgeDialFailure(readDialFailure(revoked), 0);
    ({ refusals } = judgeDialFailure(readDialFailure(revoked), refusals));
    ({ refusals } = judgeDialFailure(readDialFailure(new Error('down')), refusals));
    expect(refusals).toBe(0);
    expect(judgeDialFailure(readDialFailure(revoked), refusals).verdict.action).toBe('retry');
  });
});
