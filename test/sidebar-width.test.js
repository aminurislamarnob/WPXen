import { describe, it, expect } from 'vitest';
import {
  AGENTS_SIDEBAR_DEFAULT,
  AGENTS_SIDEBAR_MAX,
  AGENTS_SIDEBAR_MIN,
  clampSidebarWidth,
  parseSidebarWidth,
} from '../src/lib/sidebarWidth.js';

describe('agents sidebar width', () => {
  it('clamps to the min and max and rounds to whole pixels', () => {
    expect(clampSidebarWidth(10)).toBe(AGENTS_SIDEBAR_MIN);
    expect(clampSidebarWidth(5000)).toBe(AGENTS_SIDEBAR_MAX);
    expect(clampSidebarWidth(300.6)).toBe(301);
  });

  it('reads a stored width, clamped', () => {
    expect(parseSidebarWidth('320')).toBe(320);
    expect(parseSidebarWidth('9999')).toBe(AGENTS_SIDEBAR_MAX);
    expect(parseSidebarWidth('120')).toBe(AGENTS_SIDEBAR_MIN);
  });

  it('falls back to the default for a missing or unusable value', () => {
    for (const raw of [null, undefined, '', 'abc', '0', '-50', 'NaN']) {
      expect(parseSidebarWidth(raw)).toBe(AGENTS_SIDEBAR_DEFAULT);
    }
  });
});
