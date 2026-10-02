'use strict';

// GitHub for the Tasks page — every call goes through the GitHub CLI (`gh`),
// so WPXen never sees or stores a token: `gh`'s own login is the auth. REST,
// search and GraphQL all run as `gh api …`.
//
// Results are always reported per repo — { repo, items } or { repo, error } —
// so one repo that's private, renamed or rate-limited never blanks the rest.
//
// `gh` is reached through `deps.runGh`, the module's test seam (vi.mock can't
// reach .cjs). The default resolves `gh` on the login-shell PATH, the same
// way agent CLIs are found; agents.cjs (and so node-pty) is loaded lazily, and
// Electron never is.

const { execFile } = require('child_process');

const GH_TIMEOUT_MS = 20000;
// A checkout fetches the PR's commits, which can take a while on a big repo.
const GH_CHECKOUT_TIMEOUT_MS = 120000;
const MAX_CONCURRENT = 4;
const SEARCH_PER_PAGE = 100; // one request per repo; the list pages locally
const SEARCH_CACHE_MS = 20000;
const REPOS_CACHE_MS = 30000;
const DETAIL_CACHE_MS = 15000;
const TIMELINE_PER_PAGE = 100;

// `input`, when given, is written to gh's stdin — writes send their JSON body
// that way (`--input -`), so empty arrays and multi-line text survive intact.
// `cwd`, when given, runs gh inside a checkout — `gh pr checkout` acts on
// the repo it's run in.
function defaultRunGh(args, { input, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const agents = require('./agents.cjs');
    const env = agents.resolveShellEnv();
    const bin = agents.resolveBin('gh', env);
    if (!bin) {
      const err = new Error('gh not found');
      err.code = 'ENOENT';
      reject(err);
      return;
    }
    const child = execFile(
      bin,
      args,
      {
        env: { ...env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
        cwd: cwd || undefined,
        timeout: cwd ? GH_CHECKOUT_TIMEOUT_MS : GH_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = String(stderr || '');
          err.stdout = String(stdout || '');
          reject(err);
        } else {
          resolve(String(stdout || ''));
        }
      }
    );
    if (input != null) child.stdin.end(input);
  });
}

const deps = {
  runGh: defaultRunGh,
  runBrewStreaming: (args, onProgress) =>
    require('./brew.cjs').runBrewStreaming(args, onProgress),
  githubReposFor: (sitePath) => require('./git.cjs').githubReposFor(sitePath),
  now: () => Date.now(),
};

function __setDeps(next) {
  Object.assign(deps, next);
  searchCache.clear();
  detailCache.clear();
  lookupCache.clear();
  reposCache = null;
}

// ── Concurrency ──────────────────────────────────────────────────────────────
// "All" can mean a dozen repos at once; GitHub's secondary rate limits punish
// bursts, so at most MAX_CONCURRENT `gh` processes run together.
let active = 0;
const waiting = [];

async function gh(args, opts) {
  if (active >= MAX_CONCURRENT) await new Promise((r) => waiting.push(r));
  active += 1;
  try {
    return await deps.runGh(args, opts);
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

// ── Errors ───────────────────────────────────────────────────────────────────
// gh's stderr, mapped to a code the page can act on and a sentence a person
// can read.

// GraphQL's answer when the token lacks an OAuth scope (Projects needs
// `read:project`, which `gh auth login` doesn't grant by default):
//   "…has not been granted the required scopes… requires one of the following
//    scopes: ['read:project'], but your token has only been granted…"
const MISSING_SCOPE = /not been granted the required scopes/i;
const REQUIRED_SCOPE = /requires one of the following scopes:\s*\[\s*'([a-z:_-]+)'/i;

function classifyError(err) {
  if (err?.code === 'ENOENT') {
    return { code: 'not-installed', message: 'The GitHub CLI (gh) is not installed.' };
  }
  // `gh api` prints a one-line summary on stderr and GitHub's JSON error body
  // — the part that says *why* — on stdout, so both are read.
  const summary = String(err?.stderr || err?.message || '');
  const text = `${summary}\n${err?.stdout || ''}`;
  if (MISSING_SCOPE.test(text)) {
    const scope = text.match(REQUIRED_SCOPE)?.[1] || null;
    return {
      code: 'missing-scope',
      scope,
      message: scope
        ? `The GitHub CLI needs the ${scope} scope for this.`
        : 'The GitHub CLI needs an extra scope for this.',
    };
  }
  const rules = [
    [
      /auth login|not logged in|authentication required|HTTP 401|bad credentials/i,
      'not-authenticated',
      'The GitHub CLI is not signed in.',
    ],
    [
      /rate limit/i,
      'rate-limited',
      'GitHub rate limit reached — try again in a few minutes.',
    ],
    [
      /HTTP 404|not found|could not resolve to a repository|resources do not exist/i,
      'not-found',
      'Repository not found, or you don’t have access to it.',
    ],
    [
      /HTTP 403|resource not accessible|permission|forbidden/i,
      'permission',
      'You don’t have permission to do that.',
    ],
    [
      /HTTP 422|validation failed|cannot be searched/i,
      'validation',
      'GitHub rejected the request.',
    ],
    [
      /could not resolve host|network|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|HTTP 5\d\d|respond to your request in time/i,
      'network',
      'Couldn’t reach GitHub — check your connection.',
    ],
  ];
  if (err?.killed)
    return { code: 'network', message: 'GitHub took too long to respond.' };
  for (const [re, code, message] of rules) if (re.test(text)) return { code, message };
  const first =
    summary.split('\n').find((l) => l.trim()) ||
    'Something went wrong talking to GitHub.';
  return { code: 'unknown', message: first.trim() };
}

// ── Preflight ────────────────────────────────────────────────────────────────

// `gh api -i user` answers three questions in one request: is the login still
// valid (not just present in gh's config), who is it, and which OAuth scopes
// it carries (the X-Oauth-Scopes header) — the page asks for `read:project`
// before Projects rather than failing on it.

// Splits `gh api -i` output into its lowercased headers and the body.
function parseHttpResponse(out) {
  const text = String(out || '').replace(/\r\n/g, '\n');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? '' : text.slice(split + 2);
  const headers = {};
  for (const line of head.split('\n').slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { headers, body };
}

// null when the header is absent — a fine-grained or app token has no OAuth
// scopes to report, so nothing can be said about them up front.
function parseScopes(header) {
  if (header == null) return null;
  return String(header)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function preflight() {
  try {
    await gh(['--version']);
  } catch (err) {
    const e = classifyError(err);
    if (e.code === 'not-installed') return { installed: false, authenticated: false };
    return { installed: true, authenticated: false, error: e };
  }
  try {
    const { headers, body } = parseHttpResponse(await gh(['api', '-i', 'user']));
    let login = null;
    try {
      login = JSON.parse(body).login || null;
    } catch {
      login = null;
    }
    return {
      installed: true,
      authenticated: true,
      login,
      scopes: parseScopes(headers['x-oauth-scopes']),
    };
  } catch (err) {
    return { installed: true, authenticated: false, error: classifyError(err) };
  }
}

// `brew install gh`, streaming brew's lines to `onProgress`. The CLI is the
// only one WPXen installs for Tasks, so the formula is fixed here rather than
// taken from the caller.
async function installGh(onProgress) {
  await deps.runBrewStreaming(['install', 'gh'], onProgress);
  return preflight();
}

// ── Repos ────────────────────────────────────────────────────────────────────
// Every Site with at least one GitHub repo, as the picker's Site → repo tree.
// Cached briefly: discovery walks the Site's folders and runs git per repo.

let reposCache = null; // { at, key, value }

async function sitesWithRepos(sites, { force = false } = {}) {
  const list = (sites || []).filter((s) => s && s.id && s.path);
  const key = list.map((s) => `${s.id}:${s.path}`).join('|');
  if (
    !force &&
    reposCache &&
    reposCache.key === key &&
    deps.now() - reposCache.at < REPOS_CACHE_MS
  ) {
    return reposCache.value;
  }
  const value = [];
  for (const site of list) {
    let repos = [];
    try {
      repos = await deps.githubReposFor(site.path);
    } catch {
      repos = [];
    }
    if (repos.length === 0) continue;
    value.push({
      siteId: site.id,
      siteName: site.name || site.id,
      repos: repos.map((r) => ({
        repo: `${r.owner}/${r.name}`,
        owner: r.owner,
        name: r.name,
        repoRoot: r.repoRoot,
      })),
    });
  }
  reposCache = { at: deps.now(), key, value };
  return value;
}

// ── Search ───────────────────────────────────────────────────────────────────

const REPO_SLUG = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

// The user's query, scoped to one repo: their own repo/org/user qualifiers are
// dropped (the picker owns scope) and `is:issue` is added when the query
// doesn't already pick a type.
function buildSearchQuery(query, repo, kind = 'issue') {
  const terms = String(query || '')
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !/^-?(repo|org|user):/i.test(t));
  if (!terms.some((t) => /^is:(issue|pr|pull-request)$/i.test(t))) {
    terms.unshift(kind === 'pr' ? 'is:pr' : 'is:issue');
  }
  return [...terms, `repo:${repo}`].join(' ');
}

const person = (u) => (u ? { login: u.login, avatarUrl: u.avatar_url || null } : null);

function normalizeIssue(item, repo) {
  return {
    kind: item.pull_request ? 'pr' : 'issue',
    repo,
    number: item.number,
    title: item.title || '',
    url: item.html_url,
    state: item.state === 'closed' ? 'closed' : 'open',
    stateReason: item.state_reason || null,
    author: item.user?.login || null,
    labels: (item.labels || []).map((l) => ({ name: l.name, color: l.color || null })),
    assignees: (item.assignees || []).map(person).filter(Boolean),
    comments: item.comments || 0,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

const searchCache = new Map(); // key -> { at, value }

async function searchRepo(repo, query, kind, force) {
  const q = buildSearchQuery(query, repo, kind);
  const key = `${kind}\n${q}`;
  const hit = searchCache.get(key);
  if (!force && hit && deps.now() - hit.at < SEARCH_CACHE_MS) return hit.value;

  const out = await gh([
    'api',
    '-X',
    'GET',
    'search/issues',
    '-f',
    `q=${q}`,
    '-f',
    'sort=updated',
    '-f',
    'order=desc',
    '-f',
    `per_page=${SEARCH_PER_PAGE}`,
  ]);
  const data = JSON.parse(out);
  const value = {
    repo,
    total: data.total_count || 0,
    items: (data.items || []).map((i) => normalizeIssue(i, repo)),
  };
  searchCache.set(key, { at: deps.now(), value });
  return value;
}

// Search issues across `repos` (owner/name slugs). One request per repo, so a
// failing repo reports its own error and the rest still list.
async function searchIssues({ repos, query = '', force = false } = {}) {
  const valid = [...new Set((repos || []).filter((r) => REPO_SLUG.test(String(r))))];
  const results = await Promise.all(
    valid.map(async (repo) => {
      try {
        return await searchRepo(repo, query, 'issue', force);
      } catch (err) {
        return { repo, error: classifyError(err) };
      }
    })
  );
  return { results };
}

// ── Pull requests ────────────────────────────────────────────────────────────
// PR rows need what search/issues doesn't carry — the review decision, the
// checks rollup and the merge state — so PRs come from GraphQL search instead.
// The check counts are GitHub's own tallies, not a walk over every check run.
//
// Merge state is asked for in a second, parallel search: GitHub computes it
// on demand, and together with the checks rollup a busy repo's search times
// out (HTTP 502) where either alone answers. Merge state is also the one
// column a row can do without, so if that half fails the list still shows.

const PULLS_PER_REPO = 50;

const PULLS_QUERY = `query($q: String!) {
  search(query: $q, type: ISSUE, first: ${PULLS_PER_REPO}) {
    issueCount
    nodes {
      ... on PullRequest {
        number title url state isDraft merged createdAt updatedAt
        author { login avatarUrl }
        headRefName baseRefName
        reviewDecision
        labels(first: 20) { nodes { name color } }
        assignees(first: 10) { nodes { login avatarUrl } }
        comments { totalCount }
        commits(last: 1) { nodes { commit { statusCheckRollup {
          state
          contexts {
            checkRunCountsByState { state count }
            statusContextCountsByState { state count }
          }
        } } } }
      }
    }
  }
}`;

const MERGE_QUERY = `query($q: String!) {
  search(query: $q, type: ISSUE, first: ${PULLS_PER_REPO}) {
    nodes { ... on PullRequest { number mergeable mergeStateStatus } }
  }
}`;

const REVIEW = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  REVIEW_REQUIRED: 'review-required',
};

function normalizeReview(decision) {
  return REVIEW[decision] || null;
}

// Check runs and commit statuses folded into GitHub's three buckets. Skipped
// and neutral runs count as passing, as GitHub's "All checks have passed"
// does; stale and cancelled ones as failing, as its red X does.
const CHECK_BUCKETS = {
  SUCCESS: 'passing',
  NEUTRAL: 'passing',
  SKIPPED: 'passing',
  COMPLETED: 'passing',
  FAILURE: 'failing',
  ERROR: 'failing',
  TIMED_OUT: 'failing',
  CANCELLED: 'failing',
  ACTION_REQUIRED: 'failing',
  STARTUP_FAILURE: 'failing',
  STALE: 'failing',
  PENDING: 'pending',
  QUEUED: 'pending',
  IN_PROGRESS: 'pending',
  WAITING: 'pending',
  REQUESTED: 'pending',
  EXPECTED: 'pending',
};

const ROLLUP_STATE = {
  SUCCESS: 'passing',
  FAILURE: 'failing',
  ERROR: 'failing',
  PENDING: 'pending',
  EXPECTED: 'pending',
};

// → { state: passing | failing | pending, passing, failing, pending, total }
//   or null when the head commit has no checks at all.
function normalizeChecks(rollup) {
  if (!rollup) return null;
  const counts = { passing: 0, failing: 0, pending: 0 };
  const tallies = [
    ...(rollup.contexts?.checkRunCountsByState || []),
    ...(rollup.contexts?.statusContextCountsByState || []),
  ];
  for (const { state, count } of tallies) {
    const bucket = CHECK_BUCKETS[state];
    if (bucket && count > 0) counts[bucket] += count;
  }
  const total = counts.passing + counts.failing + counts.pending;
  if (total === 0 && !rollup.state) return null;
  const state =
    ROLLUP_STATE[rollup.state] ||
    (counts.failing ? 'failing' : counts.pending ? 'pending' : 'passing');
  return { state, ...counts, total };
}

// merged | closed | draft | conflicts | ready | blocked | behind | unknown —
// the order GitHub's merge box checks them in.
function normalizeMerge(pr) {
  if (pr.merged || pr.state === 'MERGED') return 'merged';
  if (pr.state === 'CLOSED') return 'closed';
  if (pr.isDraft) return 'draft';
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY')
    return 'conflicts';
  switch (pr.mergeStateStatus) {
    case 'CLEAN':
    case 'HAS_HOOKS':
    case 'UNSTABLE':
      return 'ready';
    case 'BLOCKED':
      return 'blocked';
    case 'BEHIND':
      return 'behind';
    default:
      return 'unknown';
  }
}

// `mergeInfo` — { mergeable, mergeStateStatus } from the merge search, or
// undefined when that half failed.
function normalizePull(node, repo, mergeInfo) {
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup || null;
  const people = (list) =>
    (list?.nodes || []).filter(Boolean).map((u) => ({
      login: u.login,
      avatarUrl: u.avatarUrl || null,
    }));
  return {
    kind: 'pr',
    repo,
    number: node.number,
    title: node.title || '',
    url: node.url,
    state: node.state === 'OPEN' ? 'open' : 'closed',
    stateReason: node.merged || node.state === 'MERGED' ? 'merged' : null,
    draft: !!node.isDraft,
    author: node.author?.login || null,
    headRef: node.headRefName || null,
    baseRef: node.baseRefName || null,
    labels: (node.labels?.nodes || []).map((l) => ({
      name: l.name,
      color: l.color || null,
    })),
    assignees: people(node.assignees),
    comments: node.comments?.totalCount || 0,
    review: normalizeReview(node.reviewDecision),
    checks: normalizeChecks(rollup),
    merge: normalizeMerge({ ...node, ...mergeInfo }),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

// A GraphQL query through gh; GraphQL's own errors (which come back with a
// 200) are thrown like gh's, so classifyError reads them the same way.
async function graphql(query, q) {
  const data = JSON.parse(
    await gh(['api', 'graphql', '-f', `q=${q}`, '-f', `query=${query}`])
  );
  if (data.errors?.length) {
    const err = new Error('graphql');
    err.stderr = data.errors.map((e) => e.message).join('\n');
    throw err;
  }
  return data.data || {};
}

// GraphQL with string variables (`-f name=value`).
async function graphqlVars(query, vars) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push('-f', `${k}=${v}`);
  const data = JSON.parse(await gh(args));
  if (data.errors?.length) {
    const err = new Error('graphql');
    err.stderr = data.errors.map((e) => e.message).join('\n');
    throw err;
  }
  return data.data || {};
}

async function searchPullRepo(repo, query, force) {
  const q = buildSearchQuery(query, repo, 'pr');
  const key = `pr-graphql\n${q}`;
  const hit = searchCache.get(key);
  if (!force && hit && deps.now() - hit.at < SEARCH_CACHE_MS) return hit.value;

  const [rows, merges] = await Promise.all([
    graphql(PULLS_QUERY, q),
    graphql(MERGE_QUERY, q).catch(() => null),
  ]);
  const mergeBy = new Map(
    (merges?.search?.nodes || []).filter((n) => n?.number).map((n) => [n.number, n])
  );
  const search = rows.search || {};
  const value = {
    repo,
    total: search.issueCount || 0,
    items: (search.nodes || [])
      .filter((n) => n && n.number)
      .map((n) => normalizePull(n, repo, mergeBy.get(n.number))),
  };
  searchCache.set(key, { at: deps.now(), value });
  return value;
}

async function searchPulls({ repos, query = '', force = false } = {}) {
  const valid = [...new Set((repos || []).filter((r) => REPO_SLUG.test(String(r))))];
  const results = await Promise.all(
    valid.map(async (repo) => {
      try {
        return await searchPullRepo(repo, query, force);
      } catch (err) {
        return { repo, error: classifyError(err) };
      }
    })
  );
  return { results };
}

// ── Details ──────────────────────────────────────────────────────────────────
// One issue with its timeline: the comments plus the events worth showing
// (closed, reopened, labeled, assigned, referenced). Everything else GitHub
// records — subscribed, mentioned, renamed… — is dropped.

function normalizeTimelineEvent(e) {
  if (!e || !e.event) return null;
  const at = e.created_at || e.submitted_at || null;
  const base = {
    id: String(e.id || e.node_id || `${e.event}-${at}`),
    at,
    actor: person(e.actor || e.user),
  };
  switch (e.event) {
    case 'commented':
      return {
        ...base,
        type: 'comment',
        actor: person(e.user || e.actor),
        body: e.body || '',
        url: e.html_url || null,
      };
    case 'closed':
      return { ...base, type: 'closed', stateReason: e.state_reason || null };
    case 'reopened':
      return { ...base, type: 'reopened' };
    case 'merged':
      return { ...base, type: 'merged' };
    // A PR review: its verdict, and its summary comment if it has one.
    case 'reviewed': {
      const state = REVIEW_STATES[String(e.state || '').toLowerCase()];
      if (!state) return null;
      return {
        ...base,
        type: 'review',
        actor: person(e.user || e.actor),
        state,
        body: e.body || '',
        url: e.html_url || null,
      };
    }
    case 'labeled':
    case 'unlabeled':
      if (!e.label) return null;
      return {
        ...base,
        type: e.event,
        label: { name: e.label.name, color: e.label.color || null },
      };
    case 'assigned':
    case 'unassigned':
      if (!e.assignee) return null;
      return { ...base, type: e.event, assignee: person(e.assignee) };
    case 'cross-referenced': {
      const src = e.source?.issue;
      if (!src) return null;
      return {
        ...base,
        type: 'referenced',
        source: {
          kind: src.pull_request ? 'pr' : 'issue',
          repo: src.repository?.full_name || null,
          number: src.number,
          title: src.title || '',
          url: src.html_url || null,
          state: src.state === 'closed' ? 'closed' : 'open',
          merged: !!src.pull_request?.merged_at,
        },
      };
    }
    default:
      return null;
  }
}

const REVIEW_STATES = {
  approved: 'approved',
  changes_requested: 'changes-requested',
  commented: 'commented',
  dismissed: 'dismissed',
};

// Oldest first. GitHub already sends them in order; a stable sort keeps a
// comment ahead of the close it came with when both share a timestamp.
function normalizeTimeline(events) {
  return (Array.isArray(events) ? events : [])
    .map(normalizeTimelineEvent)
    .filter(Boolean)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

const detailCache = new Map(); // `${repo}#${number}` -> { at, value }

async function getIssue({ repo, number, force = false } = {}) {
  const n = Number(number);
  if (!REPO_SLUG.test(String(repo)) || !Number.isInteger(n) || n <= 0) {
    return { error: { code: 'validation', message: 'Not an issue.' } };
  }
  const key = `${repo}#${n}`;
  const hit = detailCache.get(key);
  if (!force && hit && deps.now() - hit.at < DETAIL_CACHE_MS) return hit.value;
  try {
    const [issueOut, timelineOut] = await Promise.all([
      gh(['api', `repos/${repo}/issues/${n}`]),
      gh([
        'api',
        '-X',
        'GET',
        `repos/${repo}/issues/${n}/timeline`,
        '-f',
        `per_page=${TIMELINE_PER_PAGE}`,
      ]),
    ]);
    const item = JSON.parse(issueOut);
    const events = JSON.parse(timelineOut);
    const value = {
      issue: { ...normalizeIssue(item, repo), body: item.body || '' },
      timeline: normalizeTimeline(events),
      // One page of history; a longer thread says so and links to GitHub.
      truncated: Array.isArray(events) && events.length >= TIMELINE_PER_PAGE,
    };
    detailCache.set(key, { at: deps.now(), value });
    return value;
  } catch (err) {
    return { error: classifyError(err) };
  }
}

// ── PR details ───────────────────────────────────────────────────────────────
// Read-only: the PR with its conversation (the issue timeline, which carries
// reviews and their verdicts), then its files and checks, each fetched when
// its tab first opens.

function normalizePullDetail(pr, repo) {
  const merged = !!pr.merged || !!pr.merged_at;
  return {
    kind: 'pr',
    repo,
    number: pr.number,
    title: pr.title || '',
    url: pr.html_url,
    state: pr.state === 'closed' ? 'closed' : 'open',
    stateReason: merged ? 'merged' : null,
    merged,
    draft: !!pr.draft,
    author: pr.user?.login || null,
    body: pr.body || '',
    headRef: pr.head?.ref || null,
    baseRef: pr.base?.ref || null,
    headSha: pr.head?.sha || null,
    additions: pr.additions || 0,
    deletions: pr.deletions || 0,
    changedFiles: pr.changed_files || 0,
    commits: pr.commits || 0,
    labels: (pr.labels || []).map((l) => ({ name: l.name, color: l.color || null })),
    assignees: (pr.assignees || []).map(person).filter(Boolean),
    reviewers: (pr.requested_reviewers || []).map(person).filter(Boolean),
    // REST spells the merge box in lowercase (mergeable_state: clean, dirty…);
    // folded through the same rules the list uses.
    merge: normalizeMerge({
      merged,
      state: pr.state === 'closed' ? 'CLOSED' : 'OPEN',
      isDraft: !!pr.draft,
      mergeable: pr.mergeable === false ? 'CONFLICTING' : null,
      mergeStateStatus: String(pr.mergeable_state || '').toUpperCase(),
    }),
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    mergedAt: pr.merged_at || null,
  };
}

const FILE_STATUS = [
  'added',
  'removed',
  'modified',
  'renamed',
  'copied',
  'changed',
  'unchanged',
];

function normalizeFile(f) {
  return {
    path: f.filename,
    previousPath: f.previous_filename || null,
    status: FILE_STATUS.includes(f.status) ? f.status : 'modified',
    additions: f.additions || 0,
    deletions: f.deletions || 0,
    // null for a binary file or one too large for GitHub to diff.
    patch: typeof f.patch === 'string' ? f.patch : null,
  };
}

// A check run or a commit status, as one row: name, where it stands, how
// long it took and where its logs are.
function normalizeCheckRun(r) {
  const done = r.status === 'completed';
  const started = r.started_at ? Date.parse(r.started_at) : null;
  const finished = r.completed_at ? Date.parse(r.completed_at) : null;
  return {
    id: String(r.id ?? r.name),
    name: r.name || 'check',
    // Same buckets as the list's checks rollup.
    state: done
      ? CHECK_BUCKETS[String(r.conclusion || '').toUpperCase()] || 'passing'
      : 'pending',
    conclusion: done ? r.conclusion || null : r.status || 'queued',
    durationMs: started && finished && finished >= started ? finished - started : null,
    url: r.html_url || r.details_url || null,
  };
}

function normalizeStatus(st) {
  return {
    id: `status:${st.context}`,
    name: st.context || 'status',
    state: CHECK_BUCKETS[String(st.state || '').toUpperCase()] || 'pending',
    conclusion: st.state || null,
    durationMs: null,
    url: st.target_url || null,
    description: st.description || '',
  };
}

async function cached(key, force, fn) {
  const hit = detailCache.get(key);
  if (!force && hit && deps.now() - hit.at < DETAIL_CACHE_MS) return hit.value;
  try {
    const value = await fn();
    detailCache.set(key, { at: deps.now(), value });
    return value;
  } catch (err) {
    return { error: classifyError(err) };
  }
}

function getPull({ repo, number, force = false } = {}) {
  const n = validRef(repo, number);
  if (!n) return { error: { code: 'validation', message: 'Not a pull request.' } };
  return cached(`pr:${repo}#${n}`, force, async () => {
    const [prOut, timelineOut] = await Promise.all([
      gh(['api', `repos/${repo}/pulls/${n}`]),
      gh([
        'api',
        '-X',
        'GET',
        `repos/${repo}/issues/${n}/timeline`,
        '-f',
        `per_page=${TIMELINE_PER_PAGE}`,
      ]),
    ]);
    const events = JSON.parse(timelineOut);
    return {
      pull: normalizePullDetail(JSON.parse(prOut), repo),
      timeline: normalizeTimeline(events),
      truncated: Array.isArray(events) && events.length >= TIMELINE_PER_PAGE,
    };
  });
}

function getPullFiles({ repo, number, force = false } = {}) {
  const n = validRef(repo, number);
  if (!n) return { error: { code: 'validation', message: 'Not a pull request.' } };
  return cached(`pr-files:${repo}#${n}`, force, async () => {
    const out = await gh([
      'api',
      '-X',
      'GET',
      `repos/${repo}/pulls/${n}/files`,
      '-f',
      'per_page=100',
    ]);
    const files = JSON.parse(out) || [];
    return { files: files.map(normalizeFile), truncated: files.length >= 100 };
  });
}

// Check runs (Actions and apps) and classic commit statuses for the PR's
// head commit, failing first, then pending, then passing.
const CHECK_ORDER = { failing: 0, pending: 1, passing: 2 };
function getPullChecks({ repo, sha, force = false } = {}) {
  if (!REPO_SLUG.test(String(repo)) || !/^[0-9a-f]{7,40}$/i.test(String(sha))) {
    return { error: { code: 'validation', message: 'Not a commit.' } };
  }
  return cached(`pr-checks:${repo}@${sha}`, force, async () => {
    const [runsOut, statusOut] = await Promise.all([
      gh([
        'api',
        '-X',
        'GET',
        `repos/${repo}/commits/${sha}/check-runs`,
        '-f',
        'per_page=100',
      ]),
      gh(['api', `repos/${repo}/commits/${sha}/status`]),
    ]);
    const runs = (JSON.parse(runsOut).check_runs || []).map(normalizeCheckRun);
    const statuses = (JSON.parse(statusOut).statuses || []).map(normalizeStatus);
    const checks = [...runs, ...statuses].sort(
      (a, b) =>
        CHECK_ORDER[a.state] - CHECK_ORDER[b.state] || a.name.localeCompare(b.name)
    );
    return { checks };
  });
}

// ── Projects (v2) ────────────────────────────────────────────────────────────
// GraphQL only, and it needs the `read:project` scope that `gh auth login`
// doesn't grant by default — the missing-scope error is how the page learns
// to offer Grant access.

const PROJECT_FIELDS = `id number title url closed updatedAt
  owner { __typename ... on User { login } ... on Organization { login } }`;

const PROJECTS_QUERY = `query {
  viewer {
    login
    projectsV2(first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { ${PROJECT_FIELDS} }
    }
    organizations(first: 50) {
      nodes {
        login
        projectsV2(first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes { ${PROJECT_FIELDS} }
        }
      }
    }
  }
}`;

const PROJECT_QUERY = `
  query($id: ID!, $after: String) {
    node(id: $id) {
      ... on ProjectV2 {
        id number title url closed
        fields(first: 50) {
          nodes {
            __typename
            ... on ProjectV2FieldCommon { id name dataType }
            ... on ProjectV2SingleSelectField { options { id name color } }
            ... on ProjectV2IterationField { configuration { iterations { id title startDate duration } } }
          }
        }
        items(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id type isArchived
            content {
              __typename
              ... on Issue {
                number title url state stateReason
                repository { nameWithOwner }
                assignees(first: 10) { nodes { login avatarUrl } }
                labels(first: 10) { nodes { name color } }
              }
              ... on PullRequest {
                number title url state merged
                repository { nameWithOwner }
                assignees(first: 10) { nodes { login avatarUrl } }
                labels(first: 10) { nodes { name color } }
              }
              ... on DraftIssue { title body }
            }
            fieldValues(first: 30) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldSingleSelectValue { name optionId field { ... on ProjectV2FieldCommon { id } } }
                ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { id } } }
                ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { id } } }
                ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { id } } }
                ... on ProjectV2ItemFieldIterationValue { title startDate iterationId field { ... on ProjectV2FieldCommon { id } } }
              }
            }
          }
        }
      }
    }
  }
`;

const PROJECT_PAGES = 5; // 500 items; a bigger board says so

function normalizeProject(p) {
  return {
    id: p.id,
    number: p.number,
    title: p.title || 'Untitled project',
    url: p.url,
    closed: !!p.closed,
    updatedAt: p.updatedAt || null,
    owner: p.owner?.login || null,
    ownerType: p.owner?.__typename === 'Organization' ? 'org' : 'user',
  };
}

// The viewer's projects, then each organisation's, deduped by id. Closed
// projects sort last.
function normalizeProjects(viewer) {
  const all = [
    ...(viewer?.projectsV2?.nodes || []),
    ...(viewer?.organizations?.nodes || []).flatMap((o) => o?.projectsV2?.nodes || []),
  ].filter((p) => p && p.id);
  const seen = new Set();
  const out = [];
  for (const p of all) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(normalizeProject(p));
  }
  return out.sort((a, b) => Number(a.closed) - Number(b.closed));
}

// The project's own fields — not the built-ins every item already carries
// (title, assignees, labels, repository…), which the table shows from the
// item itself.
const FIELD_TYPES = ['SINGLE_SELECT', 'ITERATION', 'TEXT', 'NUMBER', 'DATE'];

function normalizeFields(nodes) {
  return (nodes || [])
    .filter((f) => f && f.id && FIELD_TYPES.includes(f.dataType))
    .map((f) => ({
      id: f.id,
      name: f.name,
      type: f.dataType,
      options: (f.options || []).map((o) => ({
        id: o.id,
        name: o.name,
        color: o.color || null,
      })),
      iterations: (f.configuration?.iterations || []).map((i) => ({
        id: i.id,
        title: i.title,
        startDate: i.startDate,
      })),
    }));
}

// The board's columns come from the Status field — the single select GitHub
// creates as "Status" — falling back to the first single select a project
// has, else none (Board then shows one column).
function statusField(fields) {
  const selects = fields.filter((f) => f.type === 'SINGLE_SELECT');
  return selects.find((f) => f.name.toLowerCase() === 'status') || selects[0] || null;
}

function fieldValue(v) {
  switch (v.__typename) {
    case 'ProjectV2ItemFieldSingleSelectValue':
      return { text: v.name || '', optionId: v.optionId || null };
    case 'ProjectV2ItemFieldTextValue':
      return { text: v.text || '' };
    case 'ProjectV2ItemFieldNumberValue':
      return { text: v.number == null ? '' : String(v.number), number: v.number };
    case 'ProjectV2ItemFieldDateValue':
      return { text: v.date || '', date: v.date || null };
    case 'ProjectV2ItemFieldIterationValue':
      return { text: v.title || '', iterationId: v.iterationId || null };
    default:
      return null;
  }
}

const ITEM_KIND = { ISSUE: 'issue', PULL_REQUEST: 'pr', DRAFT_ISSUE: 'draft' };

function normalizeProjectItem(node) {
  const c = node.content || {};
  const values = {};
  for (const v of node.fieldValues?.nodes || []) {
    const id = v?.field?.id;
    const value = v && fieldValue(v);
    if (id && value) values[id] = value;
  }
  const kind = ITEM_KIND[node.type] || 'redacted';
  return {
    id: node.id,
    kind,
    archived: !!node.isArchived,
    repo: c.repository?.nameWithOwner || null,
    number: c.number ?? null,
    title: c.title || (kind === 'redacted' ? 'Private item' : 'Untitled'),
    url: c.url || null,
    state: c.state === 'OPEN' ? 'open' : c.state ? 'closed' : null,
    stateReason: c.merged ? 'merged' : String(c.stateReason || '').toLowerCase() || null,
    assignees: (c.assignees?.nodes || []).map((u) => ({
      login: u.login,
      avatarUrl: u.avatarUrl || null,
    })),
    labels: (c.labels?.nodes || []).map((l) => ({
      name: l.name,
      color: l.color || null,
    })),
    // Only drafts carry their body here — they have no page to open.
    body: kind === 'draft' ? c.body || '' : undefined,
    values,
  };
}

async function listProjects({ force = false } = {}) {
  return cached('projects', force, async () => {
    const data = await graphqlVars(PROJECTS_QUERY, {});
    return { projects: normalizeProjects(data.viewer) };
  });
}

async function getProject({ id, force = false } = {}) {
  if (!/^PVT_[A-Za-z0-9_-]+$/.test(String(id || ''))) {
    return { error: { code: 'validation', message: 'Not a project.' } };
  }
  return cached(`project:${id}`, force, async () => {
    let after = null;
    let project = null;
    const items = [];
    let truncated = false;
    for (let page = 0; page < PROJECT_PAGES; page += 1) {
      const data = await graphqlVars(PROJECT_QUERY, after ? { id, after } : { id });
      const node = data.node;
      if (!node)
        throw Object.assign(new Error('Not Found'), { stderr: 'HTTP 404: Not Found' });
      project = project || node;
      items.push(...(node.items?.nodes || []).filter(Boolean));
      const info = node.items?.pageInfo;
      if (!info?.hasNextPage) break;
      after = info.endCursor;
      truncated = page === PROJECT_PAGES - 1;
    }
    const fields = normalizeFields(project.fields?.nodes);
    return {
      project: normalizeProject(project),
      fields,
      statusFieldId: statusField(fields)?.id || null,
      items: items.map(normalizeProjectItem).filter((i) => !i.archived),
      truncated,
    };
  });
}

// Moving a card: set (or, for No Status, clear) an item's single-select
// field. Needs the `project` scope — the error names it, so the page can
// offer Grant access.
const SET_OPTION_MUTATION = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
    value: { singleSelectOptionId: $optionId }
  }) { projectV2Item { id } }
}`;

const CLEAR_FIELD_MUTATION = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
  clearProjectV2ItemFieldValue(input: {
    projectId: $projectId, itemId: $itemId, fieldId: $fieldId
  }) { projectV2Item { id } }
}`;

const NODE_ID = /^[A-Za-z0-9_-]{4,200}$/;

async function setProjectItemOption({
  projectId,
  itemId,
  fieldId,
  optionId = null,
} = {}) {
  const ids = [projectId, itemId, fieldId];
  if (!ids.every((v) => NODE_ID.test(String(v || '')))) {
    return { error: { code: 'validation', message: 'Not a project item.' } };
  }
  if (optionId != null && !/^[A-Za-z0-9_-]{1,100}$/.test(String(optionId))) {
    return { error: { code: 'validation', message: 'Not a Status option.' } };
  }
  try {
    if (optionId == null) {
      await graphqlVars(CLEAR_FIELD_MUTATION, { projectId, itemId, fieldId });
    } else {
      await graphqlVars(SET_OPTION_MUTATION, { projectId, itemId, fieldId, optionId });
    }
    detailCache.delete(`project:${projectId}`);
    return { ok: true };
  } catch (err) {
    return { error: classifyError(err) };
  }
}

// ── Writes ───────────────────────────────────────────────────────────────────
// Every write is one REST call with its JSON body on stdin. A write drops the
// caches it could have made stale — the issue's details and every list — so
// the next read shows the change.

function validRef(repo, number) {
  const n = Number(number);
  return REPO_SLUG.test(String(repo)) && Number.isInteger(n) && n > 0 ? n : null;
}

async function write(method, path, body) {
  const out = await gh(['api', '-X', method, path, '--input', '-'], {
    input: JSON.stringify(body),
  });
  return out.trim() ? JSON.parse(out) : null;
}

function invalidate(repo, number) {
  if (number != null) detailCache.delete(`${repo}#${number}`);
  searchCache.clear();
}

// Runs `fn` for a valid issue reference; errors come back classified.
async function onIssue(repo, number, fn) {
  const n = validRef(repo, number);
  if (!n) return { error: { code: 'validation', message: 'Not an issue.' } };
  try {
    const result = await fn(n);
    invalidate(repo, n);
    return result;
  } catch (err) {
    return { error: classifyError(err) };
  }
}

const issueResult = (item, repo) => ({
  issue: { ...normalizeIssue(item, repo), body: item.body || '' },
});

function addComment({ repo, number, body } = {}) {
  const text = String(body || '');
  if (!text.trim())
    return { error: { code: 'validation', message: 'Write a comment first.' } };
  return onIssue(repo, number, async (n) => {
    const c = await write('POST', `repos/${repo}/issues/${n}/comments`, { body: text });
    return { comment: normalizeTimelineEvent({ ...c, event: 'commented' }) };
  });
}

const CLOSE_REASONS = ['completed', 'not_planned'];

// state 'closed' (with reason completed | not_planned) or 'open' (reopen).
function setIssueState({ repo, number, state, reason = 'completed' } = {}) {
  if (state !== 'open' && state !== 'closed') {
    return { error: { code: 'validation', message: 'Unknown state.' } };
  }
  const body =
    state === 'open'
      ? { state: 'open', state_reason: 'reopened' }
      : {
          state: 'closed',
          state_reason: CLOSE_REASONS.includes(reason) ? reason : 'completed',
        };
  return onIssue(repo, number, async (n) =>
    issueResult(await write('PATCH', `repos/${repo}/issues/${n}`, body), repo)
  );
}

function editIssue({ repo, number, title, body } = {}) {
  const patch = {};
  if (title != null) {
    const t = String(title).trim();
    if (!t) return { error: { code: 'validation', message: 'A title is required.' } };
    patch.title = t;
  }
  if (body != null) patch.body = String(body);
  if (!Object.keys(patch).length) {
    return { error: { code: 'validation', message: 'Nothing to save.' } };
  }
  return onIssue(repo, number, async (n) =>
    issueResult(await write('PATCH', `repos/${repo}/issues/${n}`, patch), repo)
  );
}

const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const cleanList = (list, ok) => [...new Set((list || []).map(String).filter(ok))];

// Replaces the whole set — the picker sends what should be there.
function setAssignees({ repo, number, assignees } = {}) {
  const logins = cleanList(assignees, (l) => LOGIN.test(l));
  return onIssue(repo, number, async (n) =>
    issueResult(
      await write('PATCH', `repos/${repo}/issues/${n}`, { assignees: logins }),
      repo
    )
  );
}

function setLabels({ repo, number, labels } = {}) {
  const names = cleanList(labels, (l) => l.trim() && l.length <= 100);
  return onIssue(repo, number, async (n) => {
    await write('PUT', `repos/${repo}/issues/${n}/labels`, { labels: names });
    // PUT answers with the labels alone; the caller wants the whole issue.
    const item = JSON.parse(await gh(['api', `repos/${repo}/issues/${n}`]));
    return issueResult(item, repo);
  });
}

async function createIssue({ repo, title, body = '' } = {}) {
  if (!REPO_SLUG.test(String(repo))) {
    return { error: { code: 'validation', message: 'Pick a repository.' } };
  }
  const t = String(title || '').trim();
  if (!t) return { error: { code: 'validation', message: 'A title is required.' } };
  try {
    const item = await write('POST', `repos/${repo}/issues`, {
      title: t,
      body: String(body),
    });
    invalidate(repo, null);
    return issueResult(item, repo);
  } catch (err) {
    return { error: classifyError(err) };
  }
}

// ── Lookups ──────────────────────────────────────────────────────────────────
// What the Assignees and Labels pickers offer: the repo's own assignable
// users and labels. Cached a minute — they rarely change mid-session.

const LOOKUP_CACHE_MS = 60000;
const lookupCache = new Map();

async function lookup(kind, repo, path, map, force) {
  if (!REPO_SLUG.test(String(repo))) {
    return { error: { code: 'validation', message: 'Not a repository.' } };
  }
  const key = `${kind}:${repo}`;
  const hit = lookupCache.get(key);
  if (!force && hit && deps.now() - hit.at < LOOKUP_CACHE_MS) return hit.value;
  try {
    const out = await gh(['api', '-X', 'GET', path, '-f', 'per_page=100']);
    const value = { items: (JSON.parse(out) || []).map(map) };
    lookupCache.set(key, { at: deps.now(), value });
    return value;
  } catch (err) {
    return { error: classifyError(err) };
  }
}

function repoAssignees({ repo, force = false } = {}) {
  return lookup('assignees', repo, `repos/${repo}/assignees`, person, force);
}

function repoLabels({ repo, force = false } = {}) {
  return lookup(
    'labels',
    repo,
    `repos/${repo}/labels`,
    (l) => ({ name: l.name, color: l.color || null, description: l.description || '' }),
    force
  );
}

// `gh pr checkout <n>` in a checkout, for Start → on a PR. `--repo` pins the
// PR's repo, so a fork with both `origin` and `upstream` never makes gh ask
// which one is meant (prompts are disabled, so asking would fail).
async function checkoutPull({ repo, number, cwd }) {
  const n = validRef(repo, number);
  if (!n) return { error: { code: 'validation', message: 'Not a pull request.' } };
  try {
    await gh(['pr', 'checkout', String(n), '--repo', repo], { cwd });
    return { ok: true };
  } catch (err) {
    const classified = classifyError(err);
    // gh's own last line ("fatal: …", "could not …") says more than a code.
    const detail = String(err?.stderr || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    return { error: { ...classified, message: detail || classified.message } };
  }
}

module.exports = {
  MAX_CONCURRENT,
  PULLS_PER_REPO,
  SEARCH_PER_PAGE,
  classifyError,
  preflight,
  parseHttpResponse,
  parseScopes,
  installGh,
  sitesWithRepos,
  buildSearchQuery,
  normalizeIssue,
  searchIssues,
  normalizeReview,
  normalizeChecks,
  normalizeMerge,
  normalizePull,
  searchPulls,
  normalizeTimeline,
  getIssue,
  normalizePullDetail,
  normalizeFile,
  normalizeCheckRun,
  normalizeStatus,
  getPull,
  getPullFiles,
  getPullChecks,
  checkoutPull,
  normalizeProjects,
  normalizeFields,
  normalizeProjectItem,
  listProjects,
  getProject,
  setProjectItemOption,
  addComment,
  setIssueState,
  editIssue,
  setAssignees,
  setLabels,
  createIssue,
  repoAssignees,
  repoLabels,
  __setDeps,
};
