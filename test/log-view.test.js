import { describe, it, expect } from 'vitest';
import { prependOlder, formatLogSize } from '../src/lib/logView.js';

const entry = (offset, text = `entry at ${offset}`) => ({
  offset,
  time: '12-Nov-2026 10:00:00 UTC',
  level: 'notice',
  text,
});

describe('prependOlder', () => {
  it('puts an older page above the entries already shown', () => {
    const view = {
      path: '/x.log',
      size: 900,
      entries: [entry(300), entry(600)],
      pageStart: 300,
      atStart: false,
    };
    const older = {
      path: '/x.log',
      size: 900,
      entries: [entry(0), entry(150)],
      pageStart: 0,
      atStart: true,
    };

    expect(prependOlder(view, older)).toEqual({
      path: '/x.log',
      size: 900,
      entries: [entry(0), entry(150), entry(300), entry(600)],
      pageStart: 0,
      atStart: true,
    });
  });

  it('never shows an entry twice, even if an older page overlaps', () => {
    const view = { entries: [entry(300), entry(600)], pageStart: 300, atStart: false };
    const older = { entries: [entry(150), entry(300)], pageStart: 150, atStart: false };

    expect(prependOlder(view, older).entries.map((e) => e.offset)).toEqual([
      150, 300, 600,
    ]);
  });
});

describe('formatLogSize', () => {
  it('shows bytes, KB and MB the way the footer reads', () => {
    expect(formatLogSize(0)).toBe('0 B');
    expect(formatLogSize(512)).toBe('512 B');
    expect(formatLogSize(1536)).toBe('1.5 KB');
    expect(formatLogSize(200 * 1024 * 1024)).toBe('200.0 MB');
  });
});
