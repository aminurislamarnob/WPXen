import { describe, it, expect } from 'vitest';
import { contextMeter } from '../src/lib/contextMeter.js';

describe('contextMeter', () => {
  it('shows a percentage for known models', () => {
    expect(contextMeter({ model: 'claude-opus-5-5', tokens: 620_000 })).toEqual({
      label: '62% of context',
      percent: 62,
    });
    expect(contextMeter({ model: 'claude-haiku-4-5', tokens: 50_000 }).label).toBe(
      '25% of context'
    );
  });

  it('matches dated or suffixed ids by their model prefix', () => {
    expect(contextMeter({ model: 'claude-sonnet-5-5[1m]', tokens: 10_000 }).percent).toBe(
      1
    );
    expect(
      contextMeter({ model: 'claude-haiku-4-5-20251001', tokens: 20_000 }).percent
    ).toBe(10);
  });

  it('falls back to a raw token count for unknown models', () => {
    expect(contextMeter({ model: 'gpt-something', tokens: 48_400 })).toEqual({
      label: '48k tokens',
      percent: null,
    });
  });

  it('shows nothing without usage', () => {
    expect(contextMeter(null)).toBeNull();
  });
});
