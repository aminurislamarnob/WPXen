// Tasks page model — the pure half of the GitHub Issues / PRs page: the
// project picker, merging per-repo results, paging and age labels. No React,
// no IPC, so it unit-tests in plain Node; Tasks.jsx is the glue.

export const PAGE_SIZE = 24;
export const DEFAULT_ISSUE_QUERY = 'is:open';
export const ALL = 'all';

// ── Picker ───────────────────────────────────────────────────────────────────
// The project picker is a Site → repo tree under "All". Each option carries
// the repos it selects, so the page never has to re-derive scope.
//
//   { value: 'all',               label, depth: 0, repos: [every repo] }
//   { value: 'site:<siteId>',     label, depth: 0, repos: [the Site's repos] }
//   { value: 'repo:<owner/name>', label, depth: 1, repos: [one repo], siteId }

export function buildPickerTree(sites) {
  const options = [];
  const all = [];
  for (const site of sites || []) {
    const repos = (site.repos || []).map((r) => r.repo);
    if (repos.length === 0) continue;
    all.push(...repos);
    options.push({
      value: `site:${site.siteId}`,
      label: site.siteName,
      depth: 0,
      siteId: site.siteId,
      repos,
    });
    for (const r of site.repos) {
      options.push({
        value: `repo:${r.repo}`,
        label: r.repo,
        depth: 1,
        siteId: site.siteId,
        repos: [r.repo],
      });
    }
  }
  const unique = [...new Set(all)];
  return [{ value: ALL, label: 'All projects', depth: 0, repos: unique }, ...options];
}

// The option for a stored or linked selection, falling back to "All" when it
// no longer exists (a Site removed, a remote changed).
export function resolveSelection(tree, value) {
  return tree.find((o) => o.value === value) || tree[0] || null;
}

export function siteSelection(siteId) {
  return `site:${siteId}`;
}

// ── Results ──────────────────────────────────────────────────────────────────
// Per-repo results ({ repo, total, items } | { repo, error }) become one list,
// newest activity first, with the failures kept beside it. `truncated` names
// repos with more matches than one request returns, so the page can say so
// rather than imply it's showing everything.

export function mergeResults(results) {
  const seen = new Set();
  const items = [];
  const errors = [];
  const truncated = [];
  let total = 0;
  for (const r of results || []) {
    if (r.error) {
      errors.push({ repo: r.repo, error: r.error });
      continue;
    }
    total += r.total || 0;
    if ((r.total || 0) > (r.items || []).length) truncated.push(r.repo);
    for (const item of r.items || []) {
      const key = `${item.repo}#${item.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return { items, errors, total, truncated };
}

export function paginate(items, page, size = PAGE_SIZE) {
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(1, page || 1), pageCount);
  const start = (current - 1) * size;
  return { items: items.slice(start, start + size), page: current, pageCount };
}

// ── Labels ───────────────────────────────────────────────────────────────────

// "just now", "5 minutes ago", "3 hours ago", "2 days ago", then a date.
export function timeAgo(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return 'just now';
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return plural(m, 'minute');
  const h = Math.floor(m / 60);
  if (h < 24) return plural(h, 'hour');
  const d = Math.floor(h / 24);
  if (d < 60) return plural(d, 'day');
  return new Date(t).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// A GitHub label's hex colour as text that stays readable on either theme:
// the colour itself for the dot, a translucent fill behind the name.
export function labelColor(hex) {
  return /^[0-9a-f]{6}$/i.test(hex || '') ? `#${hex}` : null;
}

// ── gh setup ─────────────────────────────────────────────────────────────────
// What the page needs from `gh` before it can list anything, as one step.

export function setupStep(preflight) {
  if (!preflight) return 'checking';
  if (!preflight.installed) return 'install';
  if (!preflight.authenticated) return 'sign-in';
  return 'ready';
}

// Whether the signed-in token carries `scope`. `scopes` is null when gh
// can't tell (a fine-grained or app token reports none), and then the call
// is simply tried — GitHub's own error is the authority.
export function hasScope(preflight, scope) {
  if (!scope) return true;
  const scopes = preflight?.scopes;
  if (!Array.isArray(scopes)) return true;
  // `project` implies `read:project`, as `repo` does its read-only parts.
  const base = scope.replace(/^read:/, '');
  return scopes.includes(scope) || scopes.includes(base);
}

const SCOPE_NAME = /^[a-z][a-z:_-]{0,40}$/;

// What to type in a terminal to sign in, or to add a scope to the existing
// login. `gh auth login` is interactive (browser + one-time code), so it runs
// in a real terminal rather than headless.
export function ghSetupCommand({ scope } = {}) {
  if (scope != null) {
    if (!SCOPE_NAME.test(String(scope))) return null;
    return `gh auth refresh --hostname github.com --scopes ${scope}`;
  }
  return 'gh auth login --hostname github.com --git-protocol https --web';
}

// ── Detail routes ────────────────────────────────────────────────────────────
// An item's details live at /tasks/<owner>/<name>/issues/<number>, under the
// Tasks route, so Back (and the window's back arrow) returns to the list.

const OWNER = /^[A-Za-z0-9-]+$/;
const NAME = /^[A-Za-z0-9._-]+$/;

export function detailPath(item) {
  const [owner, name] = String(item?.repo || '').split('/');
  return `/tasks/${owner}/${name}/issues/${item.number}`;
}

// The part of the path after /tasks/ → { repo, number }, or null for the list.
export function parseDetailPath(rest) {
  const [owner, name, kind, num, ...extra] = String(rest || '')
    .split('/')
    .filter(Boolean);
  if (extra.length || kind !== 'issues') return null;
  if (!OWNER.test(owner || '') || !NAME.test(name || '')) return null;
  const number = Number(num);
  if (!Number.isInteger(number) || number <= 0 || String(number) !== num) return null;
  return { repo: `${owner}/${name}`, number };
}
