import { describe, expect, it } from 'vitest';
import { createResumeGate } from './resumeGate';

describe('resume gate', () => {
  it('nudges on active after a background stay, once', () => {
    const resumed = createResumeGate('active');
    expect(resumed('inactive')).toBe(false);
    expect(resumed('background')).toBe(false);
    expect(resumed('active')).toBe(true);
    expect(resumed('active')).toBe(false);
  });

  it('stays quiet for inactive → active (Control Center, app switcher peek)', () => {
    const resumed = createResumeGate('active');
    expect(resumed('inactive')).toBe(false);
    expect(resumed('active')).toBe(false);
  });

  it('counts a launch into the background as a background stay', () => {
    const resumed = createResumeGate('background');
    expect(resumed('active')).toBe(true);
  });
});
