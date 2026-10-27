import { describe, it, expect } from 'vitest';
import {
  pinnedIndexes,
  revealIndexAfterPrepend,
  shouldStickToBottom,
} from '../src/lib/chatList.js';
import { foldToolRuns, prependOlder } from '../src/lib/chatRows.js';

// A virtualiser range: rows 10-14 visible, overscan 2.
const range = { startIndex: 10, endIndex: 14, overscan: 2, count: 100 };

describe('pinnedIndexes', () => {
  it('adds the last row to the visible range, sorted', () => {
    expect(pinnedIndexes(range, { count: 100 })).toEqual([
      8, 9, 10, 11, 12, 13, 14, 15, 16, 99,
    ]);
  });

  it('adds a revealed row, ignoring one out of bounds', () => {
    expect(pinnedIndexes(range, { count: 100, reveal: 40 })).toContain(40);
    expect(pinnedIndexes(range, { count: 100, reveal: 100 })).not.toContain(100);
    expect(pinnedIndexes(range, { count: 100, reveal: -1 })).toHaveLength(10);
  });

  it('pins nothing extra for an empty list', () => {
    expect(
      pinnedIndexes({ ...range, startIndex: 0, endIndex: -1, count: 0 }, { count: 0 })
    ).toEqual([]);
  });
});

describe('shouldStickToBottom', () => {
  it('sticks within the threshold of the bottom', () => {
    expect(
      shouldStickToBottom({ scrollTop: 952, scrollHeight: 1500, clientHeight: 500 })
    ).toBe(true);
    expect(
      shouldStickToBottom({ scrollTop: 900, scrollHeight: 1500, clientHeight: 500 })
    ).toBe(false);
    expect(
      shouldStickToBottom({
        scrollTop: 900,
        scrollHeight: 1500,
        clientHeight: 500,
        threshold: 120,
      })
    ).toBe(true);
  });

  it('sticks while the list has no size yet', () => {
    expect(shouldStickToBottom({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })).toBe(
      true
    );
  });
});

describe('revealIndexAfterPrepend', () => {
  it('finds the row that was first, even once folded into a run', () => {
    const before = [
      { id: 'call-2', role: 'tool', tool_use: { name: 'Read' } },
      { id: 'a-1', role: 'assistant', content: 'ok' },
    ];
    const older = [
      { id: 'u-1', role: 'user', content: 'go' },
      { id: 'call-1', role: 'tool', tool_use: { name: 'Read' } },
    ];
    const folded = foldToolRuns(prependOlder(before, older));
    // call-1 and call-2 now share one run, whose id is call-1's.
    const index = revealIndexAfterPrepend(folded, 'call-2');
    expect(folded[index].items.map((r) => r.id)).toEqual(['call-1', 'call-2']);
    expect(pinnedIndexes(range, { count: folded.length, reveal: index })).toContain(
      index
    );
  });

  it('is -1 without an anchor or once the row is gone', () => {
    expect(revealIndexAfterPrepend([{ id: 'x' }], null)).toBe(-1);
    expect(revealIndexAfterPrepend([{ id: 'x' }], 'y')).toBe(-1);
  });
});
