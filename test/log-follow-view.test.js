import { describe, it, expect } from 'vitest';
import {
  followLive,
  mergeLive,
  followStart,
  visibleLive,
  liveForView,
  countLive,
} from '../src/lib/logFollow.js';

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

// ── Live entries through the level filter (#211 × #213) ──────────────────
const at = (offset, level) => ({ ...entry(offset), level });

describe('followStart', () => {
  it('starts a filtered page at the newest entry of any level, not the newest shown', () => {
    const page = { entries: [at(0, 'fatal')], end: 900, lastOffset: 800 };
    expect(followStart(page)).toEqual({ from: 800, end: 900 });
  });

  it('falls back to the newest entry shown, then the page end', () => {
    expect(followStart({ entries: [at(150, 'notice')], end: 300 })).toEqual({
      from: 150,
      end: 300,
    });
    expect(followStart({ entries: [], end: 0, lastOffset: null })).toEqual({
      from: 0,
      end: 0,
    });
  });
});

describe('visibleLive / liveForView', () => {
  const pushed = [at(100, 'fatal'), at(200, 'deprecated'), at(300, 'other')];

  it('drops entries at hidden levels on an error log', () => {
    expect(visibleLive(pushed, 'debug', ['deprecated'])).toEqual([
      at(100, 'fatal'),
      at(300, 'other'),
    ]);
    expect(visibleLive(pushed, 'php-error', [])).toEqual(pushed);
  });

  it('shows every access log entry, which has no levels', () => {
    const lines = [at(0, null), at(90, null)];
    expect(visibleLive(lines, 'nginx-access', ['fatal', 'deprecated'])).toEqual(lines);
  });

  it('filters a push before mergeLive sees it, so a hidden entry is never added', () => {
    const view = { entries: [at(0, 'fatal')], size: 100 };
    const data = liveForView({ entries: pushed, size: 400 }, 'debug', ['deprecated']);
    const { view: next, added } = mergeLive(view, data);
    expect(next.entries.map((e) => e.offset)).toEqual([0, 100, 300]);
    expect(next.size).toBe(400);
    expect(added).toBe(2);
  });

  it('filters a reset page and keeps its paging', () => {
    const page = { entries: pushed, pageStart: 50, atStart: false, end: 400 };
    const next = liveForView({ reset: true, page }, 'debug', ['fatal', 'other']);
    expect(next.reset).toBe(true);
    expect(next.page).toMatchObject({ pageStart: 50, atStart: false, end: 400 });
    expect(next.page.entries).toEqual([at(200, 'deprecated')]);
  });
});

describe('countLive', () => {
  const zero = { fatal: 0, warning: 0, notice: 0, deprecated: 0, other: 0 };
  const tally = { exists: true, size: 250, counts: { ...zero, fatal: 1, notice: 2 } };

  it('adds new entries of every level, hidden ones included', () => {
    const next = countLive(tally, [at(250, 'deprecated'), at(400, 'fatal')]);
    expect(next.counts).toEqual({ ...zero, fatal: 2, notice: 2, deprecated: 1 });
  });

  it('skips what the count already covered: entries before its size', () => {
    // The watcher re-reads from the newest entry, which the count included.
    const next = countLive(tally, [at(150, 'notice'), at(300, 'warning')]);
    expect(next.counts).toEqual({ ...zero, fatal: 1, notice: 2, warning: 1 });
  });

  it('counts an entry once though it is re-read as it grows a trace', () => {
    const once = countLive(tally, [at(300, 'fatal')]);
    const twice = countLive(once, [at(300, 'fatal'), at(500, 'notice')]);
    expect(twice.counts).toEqual({ ...zero, fatal: 2, notice: 3 });
    expect(countLive(twice, [at(500, 'notice')])).toBe(twice);
  });

  it('leaves no counts alone: the access log, or counts not loaded yet', () => {
    const access = { exists: true, size: 10, counts: null };
    expect(countLive(access, [at(20, null)])).toBe(access);
    expect(countLive(null, [at(20, 'fatal')])).toBe(null);
  });
});
