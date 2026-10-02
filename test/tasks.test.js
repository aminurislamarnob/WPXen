import { describe, it, expect } from 'vitest';
import {
  PR_CHIPS,
  linkedSessions,
  sessionsFor,
  ASSIGNED_TO_ME_QUERY,
  activeFilterCount,
  applyFilters,
  chipMatches,
  parseFilters,
  tokenizeQuery,
  detailPath,
  parseDetailPath,
  ghSetupCommand,
  hasScope,
  setupStep,
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
import { hunkMarker, patchToSides } from '../src/lib/patch';

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

describe('gh setup', () => {
  it('names the one step between the page and a list', () => {
    expect(setupStep(null)).toBe('checking');
    expect(setupStep({ installed: false })).toBe('install');
    expect(setupStep({ installed: true, authenticated: false })).toBe('sign-in');
    expect(setupStep({ installed: true, authenticated: true })).toBe('ready');
  });

  it('checks a scope, treating the write scope as covering read', () => {
    const pre = { scopes: ['repo', 'project'] };
    expect(hasScope(pre, 'read:project')).toBe(true);
    expect(hasScope({ scopes: ['repo'] }, 'read:project')).toBe(false);
    expect(hasScope({ scopes: null }, 'read:project')).toBe(true); // unknown → just try
    expect(hasScope({ scopes: [] }, null)).toBe(true);
  });

  it('builds the sign-in and grant commands, refusing an odd scope', () => {
    expect(ghSetupCommand()).toBe(
      'gh auth login --hostname github.com --git-protocol https --web'
    );
    expect(ghSetupCommand({ scope: 'read:project' })).toBe(
      'gh auth refresh --hostname github.com --scopes read:project'
    );
    expect(ghSetupCommand({ scope: 'x; rm -rf ~' })).toBeNull();
  });
});

describe('detail routes', () => {
  it('round-trips an issue through its path', () => {
    const path = detailPath({ repo: 'acme/shop.site', number: 42 });
    expect(path).toBe('/tasks/acme/shop.site/issues/42');
    expect(parseDetailPath(path.replace('/tasks/', ''))).toEqual({
      repo: 'acme/shop.site',
      number: 42,
      kind: 'issue',
    });
    const pr = detailPath({ repo: 'acme/shop', number: 7, kind: 'pr' });
    expect(pr).toBe('/tasks/acme/shop/pulls/7');
    expect(parseDetailPath(pr.replace('/tasks/', ''))).toEqual({
      repo: 'acme/shop',
      number: 7,
      kind: 'pr',
    });
  });

  it('treats anything else as the list', () => {
    for (const rest of [
      '',
      undefined,
      'acme/shop',
      'acme/shop/issues',
      'acme/shop/issues/0',
      'acme/shop/issues/4x',
      'acme/shop/issues/042',
      'acme/shop/pull/4',
      'acme/shop/issues/4/extra',
      'ac me/shop/issues/4',
    ]) {
      expect(parseDetailPath(rest)).toBeNull();
    }
  });
});

describe('chips and Filters ↔ query', () => {
  it('keeps a quoted value with its qualifier', () => {
    expect(tokenizeQuery('label:"good first issue"  bug is:open')).toEqual([
      'label:"good first issue"',
      'bug',
      'is:open',
    ]);
  });

  it('lights a chip while the query holds exactly its terms', () => {
    expect(chipMatches('is:open', 'is:open')).toBe(true);
    expect(chipMatches('is:open is:issue assignee:@me', ASSIGNED_TO_ME_QUERY)).toBe(true);
    expect(chipMatches('is:open bug', 'is:open')).toBe(false);
    expect(chipMatches('', 'is:open')).toBe(false);
  });

  it('reads the Filters out of a hand-written query', () => {
    expect(
      parseFilters(
        'crash is:closed author:ana assignee:@me label:bug label:"needs review"'
      )
    ).toEqual({
      status: 'closed',
      author: 'ana',
      assignee: '@me',
      reviewer: '',
      labels: ['bug', 'needs review'],
    });
    expect(parseFilters('crash')).toEqual({
      status: 'all',
      author: '',
      assignee: '',
      reviewer: '',
      labels: [],
    });
  });

  it('writes Filters back, keeping every other term', () => {
    const q = applyFilters('crash is:open sort:created-asc label:old', {
      status: 'closed',
      author: 'ana',
      assignee: '',
      labels: ['needs review'],
    });
    expect(q).toBe('crash sort:created-asc is:closed author:ana label:"needs review"');
  });

  it('round-trips: query → Filters → query → Filters', () => {
    const filters = {
      status: 'open',
      author: 'bo',
      assignee: '@me',
      reviewer: '',
      labels: ['bug', 'good first issue'],
    };
    const q = applyFilters('free text', filters);
    expect(parseFilters(q)).toEqual(filters);
    expect(applyFilters(q, parseFilters(q))).toBe(q);
  });

  it('counts the Filters a query applies', () => {
    expect(activeFilterCount('is:open label:a label:b author:x')).toBe(4);
    expect(activeFilterCount('crash')).toBe(0);
  });
});

describe('linked Sessions', () => {
  it('maps live Sessions to their issue, newest first, ignoring exited ones', () => {
    const map = linkedSessions([
      { sessionId: 'a', startedAt: 1, issue: { repo: 'Acme/Shop', number: 7 } },
      { sessionId: 'b', startedAt: 2, issue: { repo: 'acme/shop', number: 7 } },
      {
        sessionId: 'c',
        startedAt: 3,
        exited: true,
        issue: { repo: 'acme/shop', number: 7 },
      },
      { sessionId: 'd', startedAt: 4 },
    ]);
    expect(
      sessionsFor(map, { repo: 'acme/shop', number: 7 }).map((s) => s.sessionId)
    ).toEqual(['b', 'a']);
    expect(sessionsFor(map, { repo: 'acme/shop', number: 8 })).toEqual([]);
  });
});

describe('PR chips and Filters', () => {
  it('lights Mine and Needs my review from their queries', () => {
    const [, mine, review] = PR_CHIPS;
    expect(chipMatches('is:open author:@me', mine.query)).toBe(true);
    expect(chipMatches('review-requested:@me is:open', review.query)).toBe(true);
  });

  it('round-trips merged status and the reviewer', () => {
    const filters = {
      status: 'merged',
      author: '',
      assignee: '',
      reviewer: 'ana',
      labels: ['release'],
    };
    const q = applyFilters('fix', filters);
    expect(q).toBe('fix is:merged review-requested:ana label:release');
    expect(parseFilters(q)).toEqual(filters);
    expect(activeFilterCount(q)).toBe(3);
  });
});

describe('patchToSides', () => {
  it('splits hunks into the two sides, marking skipped code between them', () => {
    const patch = [
      '@@ -1,3 +1,3 @@ header',
      ' keep',
      '-old',
      '+new',
      ' tail',
      '@@ -20,2 +20,3 @@',
      ' a',
      '+b',
      '\\ No newline at end of file',
    ].join('\n');
    const { original, modified } = patchToSides(patch);
    expect(original.split('\n')).toEqual([
      hunkMarker('1', '1', ' header'),
      'keep',
      'old',
      'tail',
      hunkMarker('20', '20'),
      'a',
    ]);
    expect(modified.split('\n')).toEqual([
      hunkMarker('1', '1', ' header'),
      'keep',
      'new',
      'tail',
      hunkMarker('20', '20'),
      'a',
      'b',
    ]);
  });

  it('handles an empty or missing patch', () => {
    expect(patchToSides(null)).toEqual({ original: '', modified: '' });
  });
});
