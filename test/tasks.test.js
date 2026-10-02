import { describe, it, expect } from 'vitest';
import {
  ALL,
  PAGE_SIZE,
  buildPickerTree,
  resolveSelection,
  siteSelection,
  mergeResults,
  paginate,
  timeAgo,
  labelColor,
} from '../src/lib/tasks';

const sites = [
  {
    siteId: 'shop',
    siteName: 'Shop',
    repos: [{ repo: 'acme/shop-theme' }, { repo: 'acme/shop-plugin' }],
  },
  { siteId: 'blog', siteName: 'Blog', repos: [{ repo: 'me/blog' }] },
  { siteId: 'empty', siteName: 'Empty', repos: [] },
];

describe('buildPickerTree', () => {
  it('puts All first, then each Site followed by its repos', () => {
    const tree = buildPickerTree(sites);
    expect(tree.map((o) => [o.value, o.depth])).toEqual([
      [ALL, 0],
      ['site:shop', 0],
      ['repo:acme/shop-theme', 1],
      ['repo:acme/shop-plugin', 1],
      ['site:blog', 0],
      ['repo:me/blog', 1],
    ]);
  });

  it('gives each option the repos it selects', () => {
    const tree = buildPickerTree(sites);
    expect(resolveSelection(tree, ALL).repos).toEqual([
      'acme/shop-theme',
      'acme/shop-plugin',
      'me/blog',
    ]);
    expect(resolveSelection(tree, siteSelection('shop')).repos).toEqual([
      'acme/shop-theme',
      'acme/shop-plugin',
    ]);
    expect(resolveSelection(tree, 'repo:me/blog').repos).toEqual(['me/blog']);
  });

  it('lists a repo shared by two Sites once under All', () => {
    const tree = buildPickerTree([
      { siteId: 'a', siteName: 'A', repos: [{ repo: 'acme/x' }] },
      { siteId: 'b', siteName: 'B', repos: [{ repo: 'acme/x' }] },
    ]);
    expect(tree[0].repos).toEqual(['acme/x']);
  });

  it('falls back to All for a selection that no longer exists', () => {
    const tree = buildPickerTree(sites);
    expect(resolveSelection(tree, 'site:gone').value).toBe(ALL);
    expect(resolveSelection(buildPickerTree([]), 'x').repos).toEqual([]);
  });
});

const item = (repo, number, updatedAt) => ({ repo, number, updatedAt, title: '' });

describe('mergeResults', () => {
  it('merges repos into one list, newest activity first', () => {
    const merged = mergeResults([
      {
        repo: 'a/x',
        total: 2,
        items: [
          item('a/x', 1, '2026-09-01T00:00:00Z'),
          item('a/x', 2, '2026-09-03T00:00:00Z'),
        ],
      },
      { repo: 'b/y', total: 1, items: [item('b/y', 9, '2026-09-02T00:00:00Z')] },
    ]);
    expect(merged.items.map((i) => `${i.repo}#${i.number}`)).toEqual([
      'a/x#2',
      'b/y#9',
      'a/x#1',
    ]);
    expect(merged.total).toBe(3);
    expect(merged.errors).toEqual([]);
  });

  it('keeps failures beside the list instead of dropping the others', () => {
    const merged = mergeResults([
      { repo: 'a/x', total: 1, items: [item('a/x', 1, '2026-09-01T00:00:00Z')] },
      { repo: 'b/private', error: { code: 'not-found', message: 'nope' } },
    ]);
    expect(merged.items).toHaveLength(1);
    expect(merged.errors).toEqual([
      { repo: 'b/private', error: { code: 'not-found', message: 'nope' } },
    ]);
  });

  it('names repos with more matches than were returned', () => {
    const merged = mergeResults([
      { repo: 'a/x', total: 250, items: [item('a/x', 1, '2026-09-01T00:00:00Z')] },
    ]);
    expect(merged.truncated).toEqual(['a/x']);
  });

  it('drops duplicates', () => {
    const one = item('a/x', 1, '2026-09-01T00:00:00Z');
    expect(
      mergeResults([
        { repo: 'a/x', total: 1, items: [one] },
        { repo: 'a/x', total: 1, items: [one] },
      ]).items
    ).toHaveLength(1);
  });
});

describe('paginate', () => {
  const items = Array.from({ length: 50 }, (_, i) => i);

  it('cuts pages of 24', () => {
    expect(PAGE_SIZE).toBe(24);
    expect(paginate(items, 1)).toEqual({
      items: items.slice(0, 24),
      page: 1,
      pageCount: 3,
    });
    expect(paginate(items, 3).items).toEqual([48, 49]);
  });

  it('clamps the page into range', () => {
    expect(paginate(items, 9).page).toBe(3);
    expect(paginate(items, 0).page).toBe(1);
    expect(paginate([], 4)).toEqual({ items: [], page: 1, pageCount: 1 });
  });
});

describe('timeAgo', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  it('reads like GitHub', () => {
    expect(timeAgo('2026-10-03T11:59:30Z', now)).toBe('just now');
    expect(timeAgo('2026-10-03T11:59:00Z', now)).toBe('1 minute ago');
    expect(timeAgo('2026-10-03T09:00:00Z', now)).toBe('3 hours ago');
    expect(timeAgo('2026-09-30T12:00:00Z', now)).toBe('3 days ago');
    expect(timeAgo('2026-01-01T12:00:00Z', now)).toMatch(/2026/);
    expect(timeAgo('nope', now)).toBe('');
  });
});

describe('labelColor', () => {
  it('accepts only a 6-digit hex', () => {
    expect(labelColor('d73a4a')).toBe('#d73a4a');
    expect(labelColor('red')).toBeNull();
    expect(labelColor('d73a4a;background:url(x)')).toBeNull();
    expect(labelColor(null)).toBeNull();
  });
});
