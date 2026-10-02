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
  githubReposFor: (sitePath) => require('./git.cjs').githubReposFor(sitePath),
  now: () => Date.now(),
};

function __setDeps(next) {
  Object.assign(deps, next);
  searchCache.clear();
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

function classifyError(err) {
  if (err?.code === 'ENOENT') {
    return { code: 'not-installed', message: 'The GitHub CLI (gh) is not installed.' };
  }
  // `gh api` prints a one-line summary on stderr and GitHub's JSON error body
  // — the part that says *why* — on stdout, so both are read.
  const summary = String(err?.stderr || err?.message || '');
  const text = `${summary}\n${err?.stdout || ''}`;
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

async function preflight() {
  try {
    await gh(['--version']);
  } catch (err) {
    const e = classifyError(err);
    if (e.code === 'not-installed') return { installed: false, authenticated: false };
    return { installed: true, authenticated: false, error: e };
  }
  try {
    await gh(['auth', 'status', '--hostname', 'github.com']);
    return { installed: true, authenticated: true };
  } catch (err) {
    return { installed: true, authenticated: false, error: classifyError(err) };
  }
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

module.exports = {
  MAX_CONCURRENT,
  SEARCH_PER_PAGE,
  classifyError,
  preflight,
  sitesWithRepos,
  buildSearchQuery,
  normalizeIssue,
  searchIssues,
  __setDeps,
};
