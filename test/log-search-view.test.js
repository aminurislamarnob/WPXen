import { describe, it, expect } from 'vitest';
import { prependOlder, matchSummary } from '../src/lib/logView.js';

const entry = (offset) => ({
  offset,
  time: null,
  level: 'fatal',
  text: `match at ${offset}`,
});

describe('matchSummary', () => {
  it('says nothing before a search has returned', () => {
    expect(matchSummary(null)).toBe('');
  });

  it('counts the matches shown, and says when older ones remain', () => {
    expect(matchSummary({ entries: [], atStart: true })).toBe('No matches');
    expect(matchSummary({ entries: [entry(0)], atStart: true })).toBe('1 match');
    expect(matchSummary({ entries: [entry(0), entry(9)], atStart: true })).toBe(
      '2 matches'
    );
    expect(matchSummary({ entries: [entry(9)], atStart: false })).toBe(
      '1 match so far — more in older entries'
    );
  });
});

describe('Load more matches', () => {
  it('puts the older batch above the matches shown and carries its cursor', () => {
    const shown = {
      query: 'x',
      entries: [entry(500), entry(900)],
      pageStart: 500,
      atStart: false,
    };
    const older = {
      query: 'x',
      entries: [entry(40), entry(120)],
      pageStart: 0,
      atStart: true,
    };
    const grown = prependOlder(shown, older);
    expect(grown.entries.map((e) => e.offset)).toEqual([40, 120, 500, 900]);
    expect(grown.atStart).toBe(true);
    expect(matchSummary(grown)).toBe('4 matches');
  });
});
