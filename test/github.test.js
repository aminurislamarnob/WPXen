import { describe, it, expect, beforeEach } from 'vitest';
import github from '../electron/services/github.cjs';

// `gh` is faked through the module's own seam, so these describe what the
// Tasks page gets back for a given CLI response — not how it's fetched.

const ghError = (stderr, extra = {}) =>
  Object.assign(new Error('gh failed'), { stderr, ...extra });

function searchResponse(items, total = items.length) {
  return JSON.stringify({ total_count: total, items });
}

const apiIssue = (n, extra = {}) => ({
  number: n,
  title: `Issue ${n}`,
  html_url: `https://github.com/acme/shop/issues/${n}`,
  state: 'open',
  state_reason: null,
  user: { login: 'ana' },
  labels: [{ name: 'bug', color: 'd73a4a' }],
  assignees: [{ login: 'bo', avatar_url: 'https://avatars/bo' }],
  comments: 2,
  created_at: '2026-09-01T10:00:00Z',
  updated_at: '2026-09-02T10:00:00Z',
  ...extra,
});

let calls;
let now;
function fakeGh(handler) {
  calls = [];
  github.__setDeps({
    runGh: async (args) => {
      calls.push(args);
      return handler(args);
    },
    now: () => now,
  });
}

beforeEach(() => {
  now = 1_000_000;
});

describe('buildSearchQuery', () => {
  it('adds is:issue and the repo scope', () => {
    expect(github.buildSearchQuery('is:open', 'acme/shop')).toBe(
      'is:issue is:open repo:acme/shop'
    );
  });

  it('keeps a type the user already chose', () => {
    expect(github.buildSearchQuery('is:pr is:open', 'acme/shop')).toBe(
      'is:pr is:open repo:acme/shop'
    );
  });

  it("drops the user's own scope qualifiers — the picker owns scope", () => {
    expect(
      github.buildSearchQuery('bug repo:other/x org:evil -user:me', 'acme/shop')
    ).toBe('is:issue bug repo:acme/shop');
  });

  it('handles an empty query', () => {
    expect(github.buildSearchQuery('', 'acme/shop')).toBe('is:issue repo:acme/shop');
  });
});

describe('searchIssues', () => {
  it('runs one sorted search per repo and normalises the rows', async () => {
    fakeGh(() => searchResponse([apiIssue(7)], 31));
    const { results } = await github.searchIssues({
      repos: ['acme/shop'],
      query: 'is:open',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      'api',
      '-X',
      'GET',
      'search/issues',
      '-f',
      'q=is:issue is:open repo:acme/shop',
      '-f',
      'sort=updated',
      '-f',
      'order=desc',
      '-f',
      'per_page=100',
    ]);
    expect(results).toEqual([
      {
        repo: 'acme/shop',
        total: 31,
        items: [
          {
            kind: 'issue',
            repo: 'acme/shop',
            number: 7,
            title: 'Issue 7',
            url: 'https://github.com/acme/shop/issues/7',
            state: 'open',
            stateReason: null,
            author: 'ana',
            labels: [{ name: 'bug', color: 'd73a4a' }],
            assignees: [{ login: 'bo', avatarUrl: 'https://avatars/bo' }],
            comments: 2,
            createdAt: '2026-09-01T10:00:00Z',
            updatedAt: '2026-09-02T10:00:00Z',
          },
        ],
      },
    ]);
  });

  it('isolates a failing repo — the others still list', async () => {
    fakeGh((args) => {
      if (args[5].includes('repo:acme/private')) throw ghError('HTTP 404: Not Found');
      return searchResponse([apiIssue(1)]);
    });
    const { results } = await github.searchIssues({
      repos: ['acme/shop', 'acme/private'],
    });
    expect(results[0]).toMatchObject({ repo: 'acme/shop', total: 1 });
    expect(results[1]).toEqual({
      repo: 'acme/private',
      error: { code: 'not-found', message: expect.any(String) },
    });
  });

  it('ignores anything that is not an owner/name slug, and duplicates', async () => {
    fakeGh(() => searchResponse([]));
    await github.searchIssues({
      repos: ['acme/shop', 'acme/shop', 'bad', '../x', 'a/b c'],
    });
    expect(calls).toHaveLength(1);
  });

  it('serves a repeat search from a short cache unless forced', async () => {
    fakeGh(() => searchResponse([apiIssue(1)]));
    await github.searchIssues({ repos: ['acme/shop'] });
    await github.searchIssues({ repos: ['acme/shop'] });
    expect(calls).toHaveLength(1);
    await github.searchIssues({ repos: ['acme/shop'], force: true });
    expect(calls).toHaveLength(2);
    now += 60_000;
    await github.searchIssues({ repos: ['acme/shop'] });
    expect(calls).toHaveLength(3);
  });

  it('never runs more than the concurrency limit of gh processes at once', async () => {
    let running = 0;
    let peak = 0;
    github.__setDeps({
      runGh: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
        return searchResponse([]);
      },
      now: () => now,
    });
    const repos = Array.from({ length: 10 }, (_, i) => `acme/r${i}`);
    await github.searchIssues({ repos });
    expect(peak).toBe(github.MAX_CONCURRENT);
  });

  it('marks pull requests found by a search as PRs', () => {
    expect(
      github.normalizeIssue(apiIssue(3, { pull_request: {} }), 'acme/shop').kind
    ).toBe('pr');
  });
});

describe('classifyError', () => {
  it('maps gh failures to codes the page can act on', () => {
    const cases = [
      [Object.assign(new Error(), { code: 'ENOENT' }), 'not-installed'],
      [
        ghError('To get started with GitHub CLI, please run:  gh auth login'),
        'not-authenticated',
      ],
      [ghError('HTTP 401: Bad credentials'), 'not-authenticated'],
      [ghError('HTTP 403: API rate limit exceeded for user'), 'rate-limited'],
      [ghError('HTTP 404: Not Found (https://api.github.com/...)'), 'not-found'],
      [ghError('HTTP 403: Resource not accessible by integration'), 'permission'],
      [ghError('HTTP 422: Validation Failed'), 'validation'],
      // What search actually returns for a repo that's gone or private: the
      // reason is in the JSON body on stdout, not in stderr's summary.
      [
        ghError('gh: Validation Failed (HTTP 422)\n', {
          stdout:
            '{"message":"Validation Failed","errors":[{"message":"The listed users and repositories cannot be searched either because the resources do not exist or you do not have permission to view them."}]}',
        }),
        'not-found',
      ],
      [
        ghError(
          'error connecting to api.github.com: dial tcp: lookup api.github.com: no such host — could not resolve host'
        ),
        'network',
      ],
      [ghError('', { killed: true }), 'network'],
      [ghError('something odd\nmore'), 'unknown'],
    ];
    for (const [err, code] of cases) expect(github.classifyError(err).code).toBe(code);
  });

  it("passes an unknown error's first line through", () => {
    expect(github.classifyError(ghError('\nsomething odd\nmore')).message).toBe(
      'something odd'
    );
  });
});

const USER_RESPONSE = [
  'HTTP/2.0 200 OK',
  'Content-Type: application/json; charset=utf-8',
  'X-Oauth-Scopes: gist, read:org, repo',
  '',
  '{"login":"ana","id":1}',
].join('\r\n');

describe('preflight', () => {
  it('reports a missing gh', async () => {
    fakeGh(() => {
      throw Object.assign(new Error(), { code: 'ENOENT' });
    });
    expect(await github.preflight()).toEqual({ installed: false, authenticated: false });
  });

  it('reports a signed-out gh', async () => {
    fakeGh((args) => {
      if (args[0] === 'api')
        throw ghError('To get started with GitHub CLI, please run:  gh auth login');
      return 'gh version 2.60.0';
    });
    expect(await github.preflight()).toMatchObject({
      installed: true,
      authenticated: false,
      error: { code: 'not-authenticated' },
    });
  });

  it('reports a ready gh with its login and OAuth scopes', async () => {
    fakeGh((args) => (args[0] === 'api' ? USER_RESPONSE : 'gh version 2.60.0'));
    expect(await github.preflight()).toEqual({
      installed: true,
      authenticated: true,
      login: 'ana',
      scopes: ['gist', 'read:org', 'repo'],
    });
    expect(calls).toEqual([['--version'], ['api', '-i', 'user']]);
  });

  it('reports unknown scopes when the token carries none to report', async () => {
    fakeGh((args) =>
      args[0] === 'api' ? 'HTTP/2.0 200 OK\nServer: github.com\n\n{"login":"ana"}' : ''
    );
    expect(await github.preflight()).toMatchObject({ login: 'ana', scopes: null });
  });
});

describe('classifyError — missing scope', () => {
  it('names the scope GitHub asked for', () => {
    const err = ghError(
      'gh: GraphQL: Your token has not been granted the required scopes',
      {
        stdout:
          "Your token has not been granted the required scopes to execute this query. The 'projectsV2' field requires one of the following scopes: ['read:project'], but your token has only been granted the: ['gist', 'read:org', 'repo'] scopes.",
      }
    );
    expect(github.classifyError(err)).toMatchObject({
      code: 'missing-scope',
      scope: 'read:project',
    });
  });
});

describe('installGh', () => {
  it('installs the gh formula through brew, streaming progress, then re-checks', async () => {
    const brewCalls = [];
    const lines = [];
    github.__setDeps({
      runBrewStreaming: async (args, onProgress) => {
        brewCalls.push(args);
        onProgress('==> Pouring gh');
      },
      runGh: async (args) => (args[0] === 'api' ? USER_RESPONSE : 'gh version 2.60.0'),
      now: () => now,
    });
    const status = await github.installGh((l) => lines.push(l));
    expect(brewCalls).toEqual([['install', 'gh']]);
    expect(lines).toEqual(['==> Pouring gh']);
    expect(status).toMatchObject({ installed: true, authenticated: true });
  });

  it("surfaces brew's failure", async () => {
    github.__setDeps({
      runBrewStreaming: async () => {
        throw new Error('Homebrew is not installed');
      },
    });
    await expect(github.installGh(() => {})).rejects.toThrow(/Homebrew/);
  });
});

describe('sitesWithRepos', () => {
  const sites = [
    { id: 'shop', name: 'Shop', path: '/Sites/shop' },
    { id: 'blog', name: 'Blog', path: '/Sites/blog' },
  ];

  it('lists only Sites with GitHub repos, as a Site → repo tree', async () => {
    github.__setDeps({
      githubReposFor: async (p) =>
        p === '/Sites/shop'
          ? [
              {
                repoRoot: '/Sites/shop/wp-content/themes/t',
                owner: 'acme',
                name: 'shop-theme',
                remote: 'origin',
              },
            ]
          : [],
      now: () => now,
    });
    expect(await github.sitesWithRepos(sites)).toEqual([
      {
        siteId: 'shop',
        siteName: 'Shop',
        repos: [
          {
            repo: 'acme/shop-theme',
            owner: 'acme',
            name: 'shop-theme',
            repoRoot: '/Sites/shop/wp-content/themes/t',
          },
        ],
      },
    ]);
  });

  it('caches discovery briefly, and re-runs when forced or the Sites change', async () => {
    let runs = 0;
    github.__setDeps({
      githubReposFor: async () => {
        runs += 1;
        return [];
      },
      now: () => now,
    });
    await github.sitesWithRepos(sites);
    await github.sitesWithRepos(sites);
    expect(runs).toBe(2); // one per Site, once
    await github.sitesWithRepos(sites, { force: true });
    expect(runs).toBe(4);
    await github.sitesWithRepos(sites.slice(0, 1));
    expect(runs).toBe(5);
  });

  it('skips a Site whose discovery fails', async () => {
    github.__setDeps({
      githubReposFor: async () => {
        throw new Error('EACCES');
      },
      now: () => now,
    });
    expect(await github.sitesWithRepos(sites)).toEqual([]);
  });
});
