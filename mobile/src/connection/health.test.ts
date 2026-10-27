import { describe, expect, it } from 'vitest';
import { classifyConnection, STALE_SINCE_LAST_CONNECT_MS } from './health';

const now = 10_000_000;
const down = (attempts: number, lastConnectedAt: number | null = now - 5_000) =>
  classifyConnection({ state: 'offline', attempts, lastConnectedAt, now }).label;

describe('connection health', () => {
  it('reads a short drop as reconnecting', () => {
    expect(down(0)).toBe('Reconnecting…');
    expect(down(2)).toBe('Reconnecting…');
  });

  it("warns can't connect from the third failed dial", () => {
    expect(down(3)).toBe('Can’t connect');
    expect(down(11)).toBe('Can’t connect');
  });

  it("says can't reach Mac after twelve, once the last connect is stale", () => {
    expect(down(12)).toBe('Can’t connect'); // last connect 5 s ago: still a blip
    expect(down(12, now - STALE_SINCE_LAST_CONNECT_MS - 1)).toBe('Can’t reach Mac (last seen 1 min ago)');
    expect(down(12, null)).toBe('Can’t reach Mac');
  });

  it('keeps the final states and the connected one as they are', () => {
    expect(classifyConnection({ state: 'connected', attempts: 50, lastConnectedAt: null, now }).label).toBe(
      'Connected'
    );
    expect(classifyConnection({ state: 'auth-failed', attempts: 0, lastConnectedAt: null, now }).kind).toBe('final');
    expect(
      classifyConnection({ state: 'update-required', attempts: 0, lastConnectedAt: null, now, update: 'desktop' }).label
    ).toBe('Update WPXen on the Mac');
  });
});
