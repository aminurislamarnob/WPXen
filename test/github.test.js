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
let inputs;
let now;
function fakeGh(handler) {
  calls = [];
  inputs = [];
  github.__setDeps({
    runGh: async (args, opts) => {
      calls.push(args);
      inputs.push(opts?.input == null ? null : JSON.parse(opts.input));
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

describe('issue details', () => {
  const ev = (event, extra = {}) => ({
    event,
    id: Math.floor(Math.random() * 1e9),
    actor: { login: 'bo', avatar_url: 'https://avatars/bo' },
    created_at: '2026-09-03T10:00:00Z',
    ...extra,
  });

  it('keeps comments and key events, in order, and drops the rest', () => {
    const timeline = github.normalizeTimeline([
      ev('labeled', {
        created_at: '2026-09-01T00:00:00Z',
        label: { name: 'bug', color: 'd73a4a' },
      }),
      ev('subscribed'),
      ev('commented', {
        created_at: '2026-09-02T00:00:00Z',
        user: { login: 'ana' },
        body: 'Seeing this too',
        html_url: 'https://github.com/acme/shop/issues/7#issuecomment-1',
      }),
      ev('assigned', { created_at: '2026-09-02T00:00:00Z', assignee: { login: 'bo' } }),
      ev('mentioned'),
      ev('cross-referenced', {
        created_at: '2026-09-04T00:00:00Z',
        source: {
          issue: {
            number: 9,
            title: 'Fix it',
            html_url: 'https://github.com/acme/shop/pull/9',
            state: 'closed',
            repository: { full_name: 'acme/shop' },
            pull_request: { merged_at: '2026-09-05T00:00:00Z' },
          },
        },
      }),
      ev('closed', { created_at: '2026-09-05T00:00:00Z', state_reason: 'completed' }),
      ev('reopened', { created_at: '2026-09-06T00:00:00Z' }),
    ]);
    expect(timeline.map((t) => t.type)).toEqual([
      'labeled',
      'comment',
      'assigned',
      'referenced',
      'closed',
      'reopened',
    ]);
    expect(timeline[0].label).toEqual({ name: 'bug', color: 'd73a4a' });
    expect(timeline[1]).toMatchObject({
      actor: { login: 'ana' },
      body: 'Seeing this too',
      url: 'https://github.com/acme/shop/issues/7#issuecomment-1',
    });
    expect(timeline[2].assignee.login).toBe('bo');
    expect(timeline[3].source).toEqual({
      kind: 'pr',
      repo: 'acme/shop',
      number: 9,
      title: 'Fix it',
      url: 'https://github.com/acme/shop/pull/9',
      state: 'closed',
      merged: true,
    });
    expect(timeline[4].stateReason).toBe('completed');
  });

  it('keeps a comment ahead of the close it shares a timestamp with', () => {
    const at = '2026-09-02T00:00:00Z';
    const timeline = github.normalizeTimeline([
      ev('commented', { created_at: at, user: { login: 'ana' }, body: 'Done' }),
      ev('closed', { created_at: at }),
    ]);
    expect(timeline.map((t) => t.type)).toEqual(['comment', 'closed']);
  });

  it('fetches the issue and its timeline, normalised', async () => {
    fakeGh((args) =>
      args[1] === 'repos/acme/shop/issues/7'
        ? JSON.stringify({ ...apiIssue(7), body: 'Steps to reproduce' })
        : JSON.stringify([ev('reopened')])
    );
    const res = await github.getIssue({ repo: 'acme/shop', number: 7 });
    expect(calls).toContainEqual([
      'api',
      '-X',
      'GET',
      'repos/acme/shop/issues/7/timeline',
      '-f',
      'per_page=100',
    ]);
    expect(res.issue).toMatchObject({
      number: 7,
      body: 'Steps to reproduce',
      repo: 'acme/shop',
    });
    expect(res.timeline.map((t) => t.type)).toEqual(['reopened']);
    expect(res.truncated).toBe(false);
  });

  it('reports an error instead of throwing, and refuses a bad reference', async () => {
    fakeGh(() => {
      throw ghError('HTTP 404: Not Found');
    });
    expect((await github.getIssue({ repo: 'acme/shop', number: 7 })).error.code).toBe(
      'not-found'
    );
    expect((await github.getIssue({ repo: '../x', number: 7 })).error.code).toBe(
      'validation'
    );
    expect((await github.getIssue({ repo: 'acme/shop', number: 'x' })).error.code).toBe(
      'validation'
    );
  });
});

describe('issue writes', () => {
  const issueJson = (extra = {}) =>
    JSON.stringify({ ...apiIssue(7), body: 'b', ...extra });
  const W = (method, path) => ['api', '-X', method, path, '--input', '-'];

  it('comments', async () => {
    fakeGh(() =>
      JSON.stringify({
        id: 5,
        user: { login: 'ana' },
        body: 'On it\n\nThanks',
        created_at: '2026-09-03T00:00:00Z',
        html_url: 'https://github.com/acme/shop/issues/7#issuecomment-5',
      })
    );
    const res = await github.addComment({
      repo: 'acme/shop',
      number: 7,
      body: 'On it\n\nThanks',
    });
    expect(calls).toEqual([W('POST', 'repos/acme/shop/issues/7/comments')]);
    expect(inputs).toEqual([{ body: 'On it\n\nThanks' }]);
    expect(res.comment).toMatchObject({ type: 'comment', body: 'On it\n\nThanks' });
  });

  it('refuses an empty comment without calling gh', async () => {
    fakeGh(() => '');
    expect(
      (await github.addComment({ repo: 'acme/shop', number: 7, body: '  ' })).error.code
    ).toBe('validation');
    expect(calls).toHaveLength(0);
  });

  it('closes as completed or not planned, and reopens', async () => {
    fakeGh(() => issueJson({ state: 'closed', state_reason: 'not_planned' }));
    const res = await github.setIssueState({
      repo: 'acme/shop',
      number: 7,
      state: 'closed',
      reason: 'not_planned',
    });
    await github.setIssueState({ repo: 'acme/shop', number: 7, state: 'closed' });
    await github.setIssueState({ repo: 'acme/shop', number: 7, state: 'open' });
    expect(calls).toEqual([
      W('PATCH', 'repos/acme/shop/issues/7'),
      W('PATCH', 'repos/acme/shop/issues/7'),
      W('PATCH', 'repos/acme/shop/issues/7'),
    ]);
    expect(inputs).toEqual([
      { state: 'closed', state_reason: 'not_planned' },
      { state: 'closed', state_reason: 'completed' },
      { state: 'open', state_reason: 'reopened' },
    ]);
    expect(res.issue).toMatchObject({ state: 'closed', stateReason: 'not_planned' });
  });

  it('edits the title and body, refusing an empty title', async () => {
    fakeGh(() => issueJson());
    await github.editIssue({ repo: 'acme/shop', number: 7, title: ' New ' });
    await github.editIssue({ repo: 'acme/shop', number: 7, body: '' });
    expect(inputs).toEqual([{ title: 'New' }, { body: '' }]);
    expect(
      (await github.editIssue({ repo: 'acme/shop', number: 7, title: ' ' })).error.code
    ).toBe('validation');
    expect(calls).toHaveLength(2);
  });

  it('replaces assignees, including clearing them', async () => {
    fakeGh(() => issueJson());
    await github.setAssignees({
      repo: 'acme/shop',
      number: 7,
      assignees: ['bo', 'bo', 'x y'],
    });
    await github.setAssignees({ repo: 'acme/shop', number: 7, assignees: [] });
    expect(calls).toEqual([
      W('PATCH', 'repos/acme/shop/issues/7'),
      W('PATCH', 'repos/acme/shop/issues/7'),
    ]);
    expect(inputs).toEqual([{ assignees: ['bo'] }, { assignees: [] }]);
  });

  it('replaces labels, then re-reads the issue', async () => {
    fakeGh((args) => (args[2] === 'PUT' ? '[]' : issueJson()));
    const res = await github.setLabels({
      repo: 'acme/shop',
      number: 7,
      labels: ['bug', 'good first issue'],
    });
    expect(calls).toEqual([
      W('PUT', 'repos/acme/shop/issues/7/labels'),
      ['api', 'repos/acme/shop/issues/7'],
    ]);
    expect(inputs[0]).toEqual({ labels: ['bug', 'good first issue'] });
    expect(res.issue.number).toBe(7);
  });

  it('creates an issue in the chosen repo', async () => {
    fakeGh(() => issueJson({ number: 12 }));
    const res = await github.createIssue({
      repo: 'acme/shop',
      title: ' Broken cart ',
      body: 'x',
    });
    expect(calls).toEqual([W('POST', 'repos/acme/shop/issues')]);
    expect(inputs).toEqual([{ title: 'Broken cart', body: 'x' }]);
    expect(res.issue.number).toBe(12);
    expect((await github.createIssue({ repo: 'nope', title: 't' })).error.code).toBe(
      'validation'
    );
  });

  it('drops the cached details and lists after a write', async () => {
    fakeGh((args) => {
      if (args[1] === 'repos/acme/shop/issues/7') return issueJson();
      if (args[3] === 'search/issues') return searchResponse([]);
      if (args.includes('--input')) return issueJson();
      return '[]';
    });
    await github.getIssue({ repo: 'acme/shop', number: 7 });
    await github.searchIssues({ repos: ['acme/shop'] });
    const before = calls.length;
    await github.setIssueState({ repo: 'acme/shop', number: 7, state: 'closed' });
    await github.getIssue({ repo: 'acme/shop', number: 7 });
    await github.searchIssues({ repos: ['acme/shop'] });
    // the write, then both reads go back to gh
    expect(calls.length - before).toBe(1 + 2 + 1);
  });

  it('reports a failed write as a classified error', async () => {
    fakeGh(() => {
      throw ghError('HTTP 403: Resource not accessible by integration');
    });
    expect(
      (await github.setIssueState({ repo: 'acme/shop', number: 7, state: 'open' })).error
        .code
    ).toBe('permission');
  });
});

describe('picker lookups', () => {
  it("lists the repo's assignable users and labels, cached", async () => {
    fakeGh((args) =>
      args[3] === 'repos/acme/shop/assignees'
        ? JSON.stringify([{ login: 'bo', avatar_url: 'https://avatars/bo' }])
        : JSON.stringify([{ name: 'bug', color: 'd73a4a', description: 'Broken' }])
    );
    expect((await github.repoAssignees({ repo: 'acme/shop' })).items).toEqual([
      { login: 'bo', avatarUrl: 'https://avatars/bo' },
    ]);
    expect((await github.repoLabels({ repo: 'acme/shop' })).items).toEqual([
      { name: 'bug', color: 'd73a4a', description: 'Broken' },
    ]);
    await github.repoLabels({ repo: 'acme/shop' });
    expect(calls).toEqual([
      ['api', '-X', 'GET', 'repos/acme/shop/assignees', '-f', 'per_page=100'],
      ['api', '-X', 'GET', 'repos/acme/shop/labels', '-f', 'per_page=100'],
    ]);
  });
});

describe('pull requests', () => {
  const tally = (pairs) => pairs.map(([state, count]) => ({ state, count }));
  const rollup = (state, runs = [], statuses = []) => ({
    state,
    contexts: {
      checkRunCountsByState: tally(runs),
      statusContextCountsByState: tally(statuses),
    },
  });

  it('maps the review decision', () => {
    expect(github.normalizeReview('APPROVED')).toBe('approved');
    expect(github.normalizeReview('CHANGES_REQUESTED')).toBe('changes-requested');
    expect(github.normalizeReview('REVIEW_REQUIRED')).toBe('review-required');
    expect(github.normalizeReview(null)).toBeNull();
  });

  it('folds check runs and statuses into passing, failing and pending', () => {
    // GitHub's real tally shape: every state listed, most at zero.
    expect(
      github.normalizeChecks(
        rollup(
          'SUCCESS',
          [
            ['SUCCESS', 12],
            ['SKIPPED', 13],
            ['FAILURE', 0],
          ],
          [['SUCCESS', 1]]
        )
      )
    ).toEqual({ state: 'passing', passing: 26, failing: 0, pending: 0, total: 26 });
    expect(
      github.normalizeChecks(
        rollup('FAILURE', [
          ['SUCCESS', 3],
          ['TIMED_OUT', 1],
          ['IN_PROGRESS', 2],
        ])
      )
    ).toEqual({ state: 'failing', passing: 3, failing: 1, pending: 2, total: 6 });
    expect(
      github.normalizeChecks(rollup('PENDING', [['QUEUED', 1]], [['EXPECTED', 1]]))
    ).toMatchObject({ state: 'pending', pending: 2 });
    expect(github.normalizeChecks(null)).toBeNull();
  });

  it('derives the merge state in GitHub’s order', () => {
    const m = (pr) => github.normalizeMerge({ state: 'OPEN', ...pr });
    expect(m({ merged: true, state: 'MERGED' })).toBe('merged');
    expect(m({ state: 'CLOSED' })).toBe('closed');
    expect(m({ isDraft: true, mergeable: 'CONFLICTING' })).toBe('draft');
    expect(m({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })).toBe('conflicts');
    expect(m({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })).toBe('ready');
    expect(m({ mergeStateStatus: 'UNSTABLE' })).toBe('ready');
    expect(m({ mergeStateStatus: 'BLOCKED' })).toBe('blocked');
    expect(m({ mergeStateStatus: 'BEHIND' })).toBe('behind');
    expect(m({})).toBe('unknown');
  });

  const prNode = (n, extra = {}) => ({
    number: n,
    title: `PR ${n}`,
    url: `https://github.com/acme/shop/pull/${n}`,
    state: 'OPEN',
    isDraft: false,
    merged: false,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-02T00:00:00Z',
    author: { login: 'ana', avatarUrl: null },
    headRefName: 'fix-cart',
    baseRefName: 'main',
    reviewDecision: 'APPROVED',
    labels: { nodes: [{ name: 'bug', color: 'd73a4a' }] },
    assignees: { nodes: [] },
    comments: { totalCount: 1 },
    commits: {
      nodes: [{ commit: { statusCheckRollup: rollup('SUCCESS', [['SUCCESS', 2]]) } }],
    },
    ...extra,
  });

  it('runs the row and merge searches per repo and joins them', async () => {
    fakeGh((args) => {
      const query = args.find((a) => a.startsWith('query=')) || '';
      if (query.includes('mergeStateStatus')) {
        return JSON.stringify({
          data: {
            search: {
              nodes: [{ number: 4, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }],
            },
          },
        });
      }
      return JSON.stringify({ data: { search: { issueCount: 1, nodes: [prNode(4)] } } });
    });
    const { results } = await github.searchPulls({
      repos: ['acme/shop'],
      query: 'is:open',
    });
    expect(calls).toHaveLength(2);
    for (const args of calls) {
      expect(args.slice(0, 4)).toEqual([
        'api',
        'graphql',
        '-f',
        'q=is:pr is:open repo:acme/shop',
      ]);
    }
    expect(results[0].items[0]).toMatchObject({
      kind: 'pr',
      number: 4,
      headRef: 'fix-cart',
      baseRef: 'main',
      review: 'approved',
      checks: { state: 'passing', passing: 2, total: 2 },
      merge: 'conflicts',
    });
  });

  it('still lists rows when the merge search fails', async () => {
    fakeGh((args) => {
      const query = args.find((a) => a.startsWith('query=')) || '';
      if (query.includes('mergeStateStatus')) throw ghError('gh: HTTP 502');
      return JSON.stringify({
        data: {
          search: { issueCount: 2, nodes: [prNode(4), prNode(5, { isDraft: true })] },
        },
      });
    });
    const { results } = await github.searchPulls({ repos: ['acme/shop'] });
    expect(results[0].items.map((i) => i.merge)).toEqual(['unknown', 'draft']);
  });

  it("reports GraphQL's own errors per repo", async () => {
    fakeGh(() => JSON.stringify({ errors: [{ message: 'API rate limit exceeded' }] }));
    const { results } = await github.searchPulls({ repos: ['acme/shop'] });
    expect(results[0].error.code).toBe('rate-limited');
  });

  it('classifies a GitHub 5xx or timeout as a network problem', () => {
    expect(github.classifyError(ghError('gh: HTTP 502')).code).toBe('network');
    expect(
      github.classifyError(
        ghError("gh: We couldn't respond to your request in time. Sorry about that.")
      ).code
    ).toBe('network');
  });
});

describe('PR details', () => {
  it('normalises the PR, including the merge box from REST', () => {
    const pr = github.normalizePullDetail(
      {
        number: 12,
        title: 'Sync',
        html_url: 'https://github.com/acme/shop/pull/12',
        state: 'open',
        draft: false,
        merged: false,
        merged_at: null,
        user: { login: 'ana' },
        body: 'Adds sync',
        head: { ref: 'sync', sha: 'abc1234' },
        base: { ref: 'main' },
        additions: 10,
        deletions: 2,
        changed_files: 3,
        commits: 2,
        labels: [],
        assignees: [],
        requested_reviewers: [{ login: 'bo', avatar_url: 'x' }],
        mergeable: false,
        mergeable_state: 'dirty',
        created_at: 'c',
        updated_at: 'u',
      },
      'acme/shop'
    );
    expect(pr).toMatchObject({
      kind: 'pr',
      headRef: 'sync',
      baseRef: 'main',
      headSha: 'abc1234',
      changedFiles: 3,
      reviewers: [{ login: 'bo', avatarUrl: 'x' }],
      merge: 'conflicts',
      merged: false,
    });
    expect(
      github.normalizePullDetail(
        { state: 'closed', merged: true, merged_at: 'm', head: {}, base: {} },
        'acme/shop'
      )
    ).toMatchObject({ merge: 'merged', stateReason: 'merged', state: 'closed' });
  });

  it('normalises files, keeping a missing patch as null', () => {
    expect(
      github.normalizeFile({
        filename: 'src/b.js',
        previous_filename: 'src/a.js',
        status: 'renamed',
        additions: 1,
        deletions: 0,
        patch: '@@ -1 +1 @@\n-a\n+b',
      })
    ).toEqual({
      path: 'src/b.js',
      previousPath: 'src/a.js',
      status: 'renamed',
      additions: 1,
      deletions: 0,
      patch: '@@ -1 +1 @@\n-a\n+b',
    });
    expect(
      github.normalizeFile({ filename: 'logo.png', status: 'added' }).patch
    ).toBeNull();
  });

  it('normalises check runs and statuses with duration and log links', () => {
    expect(
      github.normalizeCheckRun({
        id: 9,
        name: 'build',
        status: 'completed',
        conclusion: 'failure',
        started_at: '2026-09-01T00:00:00Z',
        completed_at: '2026-09-01T00:01:30Z',
        html_url: 'https://github.com/acme/shop/actions/runs/1/job/9',
      })
    ).toEqual({
      id: '9',
      name: 'build',
      state: 'failing',
      conclusion: 'failure',
      durationMs: 90000,
      url: 'https://github.com/acme/shop/actions/runs/1/job/9',
    });
    expect(
      github.normalizeCheckRun({ id: 1, name: 'lint', status: 'in_progress' })
    ).toMatchObject({ state: 'pending', conclusion: 'in_progress', durationMs: null });
    expect(
      github.normalizeCheckRun({
        id: 2,
        name: 'docs',
        status: 'completed',
        conclusion: 'skipped',
      }).state
    ).toBe('passing');
    expect(
      github.normalizeStatus({
        context: 'ci/legacy',
        state: 'error',
        target_url: 'https://ci/1',
        description: 'Broke',
      })
    ).toMatchObject({ name: 'ci/legacy', state: 'failing', url: 'https://ci/1' });
  });

  it('keeps review verdicts and the merge in the conversation', () => {
    const timeline = github.normalizeTimeline([
      {
        event: 'reviewed',
        id: 1,
        state: 'changes_requested',
        user: { login: 'bo' },
        body: 'Please rename',
        submitted_at: '2026-09-01T00:00:00Z',
        html_url: 'https://github.com/acme/shop/pull/12#pullrequestreview-1',
      },
      {
        event: 'reviewed',
        id: 2,
        state: 'approved',
        user: { login: 'bo' },
        body: '',
        submitted_at: '2026-09-02T00:00:00Z',
      },
      {
        event: 'merged',
        id: 3,
        actor: { login: 'ana' },
        created_at: '2026-09-03T00:00:00Z',
      },
      { event: 'committed', sha: 'abc' },
    ]);
    expect(timeline.map((t) => [t.type, t.state])).toEqual([
      ['review', 'changes-requested'],
      ['review', 'approved'],
      ['merged', undefined],
    ]);
    expect(timeline[0]).toMatchObject({ actor: { login: 'bo' }, body: 'Please rename' });
  });

  it('fetches checks for the head commit, failing first', async () => {
    fakeGh((args) =>
      args.includes('repos/acme/shop/commits/abc1234/check-runs')
        ? JSON.stringify({
            check_runs: [
              { id: 1, name: 'b', status: 'completed', conclusion: 'success' },
              { id: 2, name: 'a', status: 'completed', conclusion: 'failure' },
              { id: 3, name: 'c', status: 'queued' },
            ],
          })
        : JSON.stringify({ statuses: [] })
    );
    const res = await github.getPullChecks({ repo: 'acme/shop', sha: 'abc1234' });
    expect(res.checks.map((c) => c.name)).toEqual(['a', 'c', 'b']);
    expect(
      (await github.getPullChecks({ repo: 'acme/shop', sha: 'not a sha' })).error.code
    ).toBe('validation');
  });
});

describe('checkoutPull', () => {
  it('runs gh pr checkout pinned to the repo, inside the checkout', async () => {
    const seen = [];
    github.__setDeps({
      runGh: async (args, opts) => {
        seen.push({ args, cwd: opts?.cwd });
        return '';
      },
    });
    expect(
      await github.checkoutPull({ repo: 'acme/shop', number: 9, cwd: '/r' })
    ).toEqual({
      ok: true,
    });
    expect(seen).toEqual([
      { args: ['pr', 'checkout', '9', '--repo', 'acme/shop'], cwd: '/r' },
    ]);
  });

  it("reports gh's last line on failure, and refuses a bad reference", async () => {
    github.__setDeps({
      runGh: async () => {
        throw ghError('From github.com:acme/shop\nfatal: could not lock ref');
      },
    });
    expect(
      (await github.checkoutPull({ repo: 'acme/shop', number: 9, cwd: '/r' })).error
        .message
    ).toBe('fatal: could not lock ref');
    expect((await github.checkoutPull({ repo: 'x', number: 9 })).error.code).toBe(
      'validation'
    );
  });
});

describe('projects', () => {
  const proj = (id, owner, extra = {}) => ({
    id,
    number: 1,
    title: `P ${id}`,
    url: `https://github.com/orgs/${owner}/projects/1`,
    closed: false,
    updatedAt: '2026-09-01T00:00:00Z',
    owner: { __typename: owner === 'ana' ? 'User' : 'Organization', login: owner },
    ...extra,
  });

  it("finds the viewer's and their organisations' projects, deduped, closed last", () => {
    const list = github.normalizeProjects({
      projectsV2: {
        nodes: [proj('PVT_a', 'ana', { closed: true }), proj('PVT_b', 'ana')],
      },
      organizations: {
        nodes: [
          {
            login: 'acme',
            projectsV2: { nodes: [proj('PVT_c', 'acme'), proj('PVT_b', 'ana')] },
          },
        ],
      },
    });
    expect(list.map((p) => [p.id, p.owner, p.ownerType, p.closed])).toEqual([
      ['PVT_b', 'ana', 'user', false],
      ['PVT_c', 'acme', 'org', false],
      ['PVT_a', 'ana', 'user', true],
    ]);
  });

  it('keeps only the project’s own fields', () => {
    const fields = github.normalizeFields([
      { id: 'F_title', name: 'Title', dataType: 'TITLE' },
      {
        id: 'F_status',
        name: 'Status',
        dataType: 'SINGLE_SELECT',
        options: [{ id: 'o1', name: 'Todo', color: 'GRAY' }],
      },
      {
        id: 'F_iter',
        name: 'Sprint',
        dataType: 'ITERATION',
        configuration: {
          iterations: [{ id: 'i1', title: 'Sprint 1', startDate: '2026-09-01' }],
        },
      },
      { id: 'F_pts', name: 'Points', dataType: 'NUMBER' },
      { id: 'F_asg', name: 'Assignees', dataType: 'ASSIGNEES' },
    ]);
    expect(fields.map((f) => [f.id, f.type])).toEqual([
      ['F_status', 'SINGLE_SELECT'],
      ['F_iter', 'ITERATION'],
      ['F_pts', 'NUMBER'],
    ]);
    expect(fields[0].options).toEqual([{ id: 'o1', name: 'Todo', color: 'GRAY' }]);
    expect(fields[1].iterations[0].title).toBe('Sprint 1');
  });

  const item = (id, extra = {}) => ({
    id,
    type: 'ISSUE',
    isArchived: false,
    content: {
      __typename: 'Issue',
      number: 7,
      title: 'Cart',
      url: 'https://github.com/acme/shop/issues/7',
      state: 'OPEN',
      repository: { nameWithOwner: 'acme/shop' },
      assignees: { nodes: [{ login: 'bo', avatarUrl: null }] },
      labels: { nodes: [{ name: 'bug', color: 'd73a4a' }] },
    },
    fieldValues: {
      nodes: [
        {
          __typename: 'ProjectV2ItemFieldSingleSelectValue',
          name: 'Todo',
          optionId: 'o1',
          field: { id: 'F_status' },
        },
        {
          __typename: 'ProjectV2ItemFieldNumberValue',
          number: 3,
          field: { id: 'F_pts' },
        },
        {
          __typename: 'ProjectV2ItemFieldIterationValue',
          title: 'Sprint 1',
          iterationId: 'i1',
          field: { id: 'F_iter' },
        },
        { __typename: 'ProjectV2ItemFieldRepositoryValue' },
      ],
    },
    ...extra,
  });

  it('normalises an item with its field values', () => {
    expect(github.normalizeProjectItem(item('PVTI_1'))).toEqual({
      id: 'PVTI_1',
      kind: 'issue',
      archived: false,
      repo: 'acme/shop',
      number: 7,
      title: 'Cart',
      url: 'https://github.com/acme/shop/issues/7',
      state: 'open',
      stateReason: null,
      assignees: [{ login: 'bo', avatarUrl: null }],
      labels: [{ name: 'bug', color: 'd73a4a' }],
      values: {
        F_status: { text: 'Todo', optionId: 'o1' },
        F_pts: { text: '3', number: 3 },
        F_iter: { text: 'Sprint 1', iterationId: 'i1' },
      },
    });
    const draft = github.normalizeProjectItem({
      id: 'PVTI_2',
      type: 'DRAFT_ISSUE',
      content: { __typename: 'DraftIssue', title: 'Idea' },
      fieldValues: { nodes: [] },
    });
    expect(draft).toMatchObject({ kind: 'draft', title: 'Idea', repo: null, url: null });
  });

  it('pages through a project’s items and drops archived ones', async () => {
    const page = (nodes, hasNextPage, endCursor) =>
      JSON.stringify({
        data: {
          node: {
            id: 'PVT_x',
            number: 2,
            title: 'Roadmap',
            url: 'u',
            closed: false,
            owner: { __typename: 'Organization', login: 'acme' },
            fields: {
              nodes: [
                {
                  id: 'F_status',
                  name: 'Status',
                  dataType: 'SINGLE_SELECT',
                  options: [],
                },
              ],
            },
            items: { pageInfo: { hasNextPage, endCursor }, nodes },
          },
        },
      });
    fakeGh((args) =>
      args.includes('after=c1')
        ? page([item('PVTI_3', { isArchived: true })], false, null)
        : page([item('PVTI_1'), item('PVTI_2')], true, 'c1')
    );
    const res = await github.getProject({ id: 'PVT_x' });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('id=PVT_x');
    expect(calls[1]).toContain('after=c1');
    expect(res.items.map((i) => i.id)).toEqual(['PVTI_1', 'PVTI_2']);
    expect(res.statusFieldId).toBe('F_status');
    expect(res.project).toMatchObject({ title: 'Roadmap', owner: 'acme' });
    expect((await github.getProject({ id: 'nope' })).error.code).toBe('validation');
  });

  it('reports a missing read:project scope so the page can offer Grant access', async () => {
    fakeGh(() => {
      throw ghError(
        "gh: Your token has not been granted the required scopes to execute this query. The 'id' field requires one of the following scopes: ['read:project'], but your token has only been granted the: ['gist', 'read:org', 'repo'] scopes."
      );
    });
    expect((await github.listProjects()).error).toMatchObject({
      code: 'missing-scope',
      scope: 'read:project',
    });
  });
});
