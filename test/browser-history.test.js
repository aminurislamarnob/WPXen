import { describe, it, expect } from 'vitest';
import history from '../electron/services/browserHistory.cjs';
import browser from '../electron/services/browser.cjs';
import { PARTITION } from '../src/lib/browser/webviewCache.js';

const { upsertEntry, searchEntries, MAX_ENTRIES } = history;

// Build a history list newest-first, the way the store holds it.
const entry = (url, over = {}) => ({
  url,
  title: '',
  faviconUrl: null,
  visitedAt: 1000,
  visits: 1,
  ...over,
});

describe('upsertEntry', () => {
  it('prepends a new visit', () => {
    const next = upsertEntry([], { url: 'https://wpherd.test' }, 5);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ url: 'https://wpherd.test', visits: 1, visitedAt: 5 });
  });

  it('dedupes by URL, moving the entry to the front and counting the visit', () => {
    const before = [entry('https://a.test'), entry('https://wpherd.test', { visits: 3 })];
    const next = upsertEntry(before, { url: 'https://wpherd.test' }, 9);

    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({
      url: 'https://wpherd.test',
      visits: 4,
      visitedAt: 9,
    });
  });

  it('keeps a title and favicon a previous visit learned', () => {
    const before = [
      entry('https://wpherd.test', { title: 'My Blog', faviconUrl: 'https://f.ico' }),
    ];
    // did-stop-loading fires before the favicon arrives, so this visit has
    // neither — it must not wipe what's already known.
    const next = upsertEntry(before, { url: 'https://wpherd.test' });
    expect(next[0].title).toBe('My Blog');
    expect(next[0].faviconUrl).toBe('https://f.ico');
  });

  it('lets a new visit update the title and favicon', () => {
    const before = [entry('https://wpherd.test', { title: 'Old' })];
    const next = upsertEntry(before, {
      url: 'https://wpherd.test',
      title: 'New',
      faviconUrl: 'https://n.ico',
    });
    expect(next[0]).toMatchObject({ title: 'New', faviconUrl: 'https://n.ico' });
  });

  it('caps the list, dropping the oldest', () => {
    const before = Array.from({ length: MAX_ENTRIES }, (_, i) =>
      entry(`https://site${i}.test`)
    );
    const next = upsertEntry(before, { url: 'https://new.test' });
    expect(next).toHaveLength(MAX_ENTRIES);
    expect(next[0].url).toBe('https://new.test');
    expect(next.some((e) => e.url === `https://site${MAX_ENTRIES - 1}.test`)).toBe(false);
  });

  it('ignores anything that is not a page you could return to', () => {
    for (const url of ['about:blank', '', null, undefined, 'file:///etc/passwd', 'data:,x']) {
      expect(upsertEntry([], { url })).toHaveLength(0);
    }
  });
});

describe('searchEntries', () => {
  const entries = [
    entry('https://wpherd.test/wp-admin', { title: 'Dashboard', visitedAt: 300 }),
    entry('https://wpherd.test', { title: 'My Blog', visitedAt: 200 }),
    entry('http://phpmyadmin.test/index.php?route=/&db=wpherd', {
      title: 'phpMyAdmin',
      visitedAt: 100,
    }),
  ];

  it('returns the most recent entries for an empty query', () => {
    expect(searchEntries(entries, '').map((e) => e.url)).toEqual(entries.map((e) => e.url));
  });

  it('ranks a host prefix above a match buried in the URL', () => {
    // "wpherd" is a prefix of two hosts and also appears in phpMyAdmin's query
    // string — the hosts must win.
    const found = searchEntries(entries, 'wpherd');
    expect(found[0].url).toBe('https://wpherd.test/wp-admin');
    expect(found[2].url).toBe('http://phpmyadmin.test/index.php?route=/&db=wpherd');
  });

  it('matches a host prefix through the scheme', () => {
    expect(searchEntries(entries, 'phpmyadmin')[0].title).toBe('phpMyAdmin');
  });

  it('matches on title', () => {
    expect(searchEntries(entries, 'dashboard')[0].url).toBe(
      'https://wpherd.test/wp-admin'
    );
  });

  it('breaks ties by recency', () => {
    const found = searchEntries(entries, 'wpherd.test');
    expect(found.map((e) => e.visitedAt)).toEqual([300, 200]);
  });

  it('is case-insensitive', () => {
    expect(searchEntries(entries, 'WPHERD.TEST')).toHaveLength(2);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(searchEntries(entries, 'zzz')).toEqual([]);
  });

  it('honours the limit', () => {
    expect(searchEntries(entries, '', 2)).toHaveLength(2);
  });
});

describe('store wrappers', () => {
  // Minimal JsonStore stand-in — dotted paths over a plain object.
  function fakeStore(initial = {}) {
    let data = structuredClone(initial);
    return {
      get: (key, fallback) => {
        const v = key.split('.').reduce((o, k) => o?.[k], data);
        return v !== undefined ? v : fallback;
      },
      set: (key, value) => {
        const keys = key.split('.');
        let obj = data;
        for (let i = 0; i < keys.length - 1; i++) {
          if (typeof obj[keys[i]] !== 'object' || obj[keys[i]] === null) obj[keys[i]] = {};
          obj = obj[keys[i]];
        }
        obj[keys[keys.length - 1]] = value;
      },
    };
  }

  it('records, searches and clears', () => {
    const store = fakeStore();
    history.record(store, { url: 'https://wpherd.test', title: 'My Blog' });
    history.record(store, { url: 'https://other.test' });

    expect(history.search(store, 'wpherd')).toHaveLength(1);
    history.clear(store);
    expect(history.search(store, '')).toEqual([]);
  });

  it('survives a store holding something that is not a list', () => {
    const store = fakeStore({ browser: { history: 'corrupt' } });
    expect(history.search(store, '')).toEqual([]);
    expect(() => history.record(store, { url: 'https://wpherd.test' })).not.toThrow();
    expect(history.search(store, '')).toHaveLength(1);
  });
});

describe('session partition', () => {
  it('is the same string in both processes', () => {
    // The renderer sets it on the <webview>; the main process wipes it for
    // "clear cookies & cache". A mismatch would silently clear nothing.
    expect(browser.PARTITION).toBe(PARTITION);
  });
});
