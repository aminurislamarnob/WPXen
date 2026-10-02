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
const MAX_CONCURRENT = 4;
const SEARCH_PER_PAGE = 100; // one request per repo; the list pages locally
const SEARCH_CACHE_MS = 20000;
const REPOS_CACHE_MS = 30000;
const DETAIL_CACHE_MS = 15000;
const TIMELINE_PER_PAGE = 100;

function defaultRunGh(args) {
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
    execFile(
      bin,
      args,
      {
        env: { ...env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
        timeout: GH_TIMEOUT_MS,
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
  reposCache = null;
}

// ── Concurrency ──────────────────────────────────────────────────────────────
// "All" can mean a dozen repos at once; GitHub's secondary rate limits punish
// bursts, so at most MAX_CONCURRENT `gh` processes run together.
let active = 0;
const waiting = [];

async function gh(args) {
  if (active >= MAX_CONCURRENT) await new Promise((r) => waiting.push(r));
  active += 1;
  try {
    return await deps.runGh(args);
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
      /could not resolve host|network|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND/i,
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

module.exports = {
  MAX_CONCURRENT,
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
  normalizeTimeline,
  getIssue,
  __setDeps,
};
