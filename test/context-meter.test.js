import { describe, it, expect } from 'vitest';
import { contextMeter } from '../src/lib/contextMeter.js';

describe('contextMeter', () => {
  it('shows a percentage when the model id names its window', () => {
    expect(contextMeter({ model: 'claude-opus-5-5[1m]', tokens: 620_000 })).toEqual({
      label: '62% of context',
      percent: 62,
    });
    expect(contextMeter({ model: 'Claude-Sonnet-5-5[1M]', tokens: 10_000 }).percent).toBe(
      1
    );
  });

  it('shows a raw token count for a bare model name, never a guessed window', () => {
    // A bare name runs 1M first-party and 200k through a gateway.
    expect(contextMeter({ model: 'claude-opus-5-5', tokens: 251_255 })).toEqual({
      label: '251k tokens',
      percent: null,
    });
    expect(
      contextMeter({ model: 'claude-haiku-4-5', tokens: 50_000 }).percent
    ).toBeNull();
  });

  it('falls back to a raw token count for unknown models', () => {
    expect(contextMeter({ model: 'gpt-something', tokens: 48_400 })).toEqual({
      label: '48k tokens',
      percent: null,
    });
  });

  it('prefers a context window the Agent reports itself', () => {
    expect(contextMeter({ model: null, tokens: 29_742, limit: 258_400 })).toEqual({
      label: '12% of context',
      percent: 12,
    });
  });

  it('shows nothing without usage', () => {
    expect(contextMeter(null)).toBeNull();
  });
});
