import { describe, it, expect } from 'vitest';
import { followLive, mergeLive } from '../src/lib/logFollow.js';

const entry = (offset, text = `entry at ${offset}`) => ({
  offset,
  time: '12-Nov-2026 10:00:00 UTC',
  level: 'notice',
  text,
});

describe('followLive: the follow rule', () => {
  const following = { atBottom: true, marker: false };
  const readingOlder = { atBottom: false, marker: false };

  it('at the bottom, new entries scroll the view to the newest', () => {
    expect(followLive(following, { type: 'entries', added: 2 })).toEqual({
      atBottom: true,
      marker: false,
      scrollToEnd: true,
    });
  });

  it('scrolled up, new entries leave the view where it is and raise the marker', () => {
    expect(followLive(readingOlder, { type: 'entries', added: 1 })).toEqual({
      atBottom: false,
      marker: true,
      scrollToEnd: false,
    });
  });

  it('scrolled up, an entry that only grew (no new ones) raises no marker', () => {
    expect(followLive(readingOlder, { type: 'entries', added: 0 })).toEqual({
      atBottom: false,
      marker: false,
      scrollToEnd: false,
    });
  });

  it('clicking New entries jumps to the newest and follows again', () => {
    const state = { atBottom: false, marker: true };
    expect(followLive(state, { type: 'jump' })).toEqual({
      atBottom: true,
      marker: false,
      scrollToEnd: true,
    });
  });

  it('scrolling back down to the bottom clears the marker', () => {
    const state = { atBottom: false, marker: true };
    expect(followLive(state, { type: 'scroll', atBottom: true })).toEqual({
      atBottom: true,
      marker: false,
      scrollToEnd: false,
    });
  });

  it('scrolling up keeps a marker that is already showing', () => {
    const state = { atBottom: false, marker: true };
    expect(followLive(state, { type: 'scroll', atBottom: false })).toEqual({
      atBottom: false,
      marker: true,
      scrollToEnd: false,
    });
  });

  it('a reset (Clear, rotation) starts over at the newest entry, following', () => {
    expect(followLive(readingOlder, { type: 'reset' })).toEqual({
      atBottom: true,
      marker: false,
      scrollToEnd: true,
    });
  });
});

describe('mergeLive', () => {
  const view = {
    path: '/x.log',
    size: 300,
    end: 300,
    entries: [entry(0), entry(150)],
    pageStart: 0,
    atStart: true,
  };

  it('replaces the newest entry when it grew and appends the new ones', () => {
    const grown = entry(150, 'entry at 150\nStack trace:\n#0 {main}');
    const { view: next, added } = mergeLive(view, {
      entries: [grown, entry(420)],
      size: 500,
    });

    expect(next.entries).toEqual([entry(0), grown, entry(420)]);
    expect(next.size).toBe(500);
    expect(added).toBe(1);
  });

  it('keeps Load older state (pageStart, atStart) as it was', () => {
    const paged = { ...view, pageStart: 0, atStart: false };
    const { view: next } = mergeLive(paged, { entries: [entry(420)], size: 500 });
    expect(next).toMatchObject({ pageStart: 0, atStart: false });
  });
});
