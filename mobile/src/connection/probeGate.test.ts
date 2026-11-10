import { describe, expect, it } from 'vitest';
import { createProbeGate } from './probeGate';

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('probe gate', () => {
  it('runs one probe at a time', () => {
    const c = clock();
    const gate = createProbeGate({ now: c.now, minIntervalMs: 5_000 });
    expect(gate.tryStart()).toBe(true);
    c.advance(10_000);
    expect(gate.tryStart()).toBe(false);
    expect(gate.tryStart({ afterBackground: true })).toBe(false);
    gate.finish();
    expect(gate.tryStart()).toBe(true);
  });

  it('spaces probes apart, so a burst of network events is one probe', () => {
    const c = clock();
    const gate = createProbeGate({ now: c.now, minIntervalMs: 5_000 });
    expect(gate.tryStart()).toBe(true);
    gate.finish();
    c.advance(1_000);
    expect(gate.tryStart()).toBe(false);
    c.advance(4_000);
    expect(gate.tryStart()).toBe(true);
  });

  it('lets a return from the background probe straight away', () => {
    const c = clock();
    const gate = createProbeGate({ now: c.now, minIntervalMs: 5_000 });
    expect(gate.tryStart()).toBe(true);
    gate.finish();
    c.advance(1_000);
    expect(gate.tryStart({ afterBackground: true })).toBe(true);
  });

  it('forgets the old socket on reset', () => {
    const c = clock();
    const gate = createProbeGate({ now: c.now, minIntervalMs: 5_000 });
    expect(gate.tryStart()).toBe(true);
    gate.reset();
    expect(gate.tryStart()).toBe(true);
  });
});
