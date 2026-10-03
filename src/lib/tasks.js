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
// An item's details live at /tasks/<owner>/<name>/issues/<number> (or
// …/pulls/<number> for a PR), under the Tasks route, so Back (and the
// window's back arrow) returns to the list.

const OWNER = /^[A-Za-z0-9-]+$/;
const NAME = /^[A-Za-z0-9._-]+$/;

export function detailPath(item) {
  const [owner, name] = String(item?.repo || '').split('/');
  const kind = item.kind === 'pr' ? 'pulls' : 'issues';
  return `/tasks/${owner}/${name}/${kind}/${item.number}`;
}

// The part of the path after /tasks/ → { repo, number, kind }, or null for
// the list.
export function parseDetailPath(rest) {
  const [owner, name, kind, num, ...extra] = String(rest || '')
    .split('/')
    .filter(Boolean);
  if (extra.length || (kind !== 'issues' && kind !== 'pulls')) return null;
  if (!OWNER.test(owner || '') || !NAME.test(name || '')) return null;
  const number = Number(num);
  if (!Number.isInteger(number) || number <= 0 || String(number) !== num) return null;
  return { repo: `${owner}/${name}`, number, kind: kind === 'pulls' ? 'pr' : 'issue' };
}

// ── Chips and Filters ↔ query ────────────────────────────────────────────────
// The search box is the single source of truth: the preset chips and the
// Filters dropdown both read the query and write qualifiers back into it, so
// hand-editing the text and using the controls never disagree.

export const ASSIGNED_TO_ME_QUERY = 'assignee:@me is:issue is:open';

export const ISSUE_CHIPS = [
  { label: 'Open', query: DEFAULT_ISSUE_QUERY },
  { label: 'Assigned to me', query: ASSIGNED_TO_ME_QUERY },
];

export const PR_CHIPS = [
  { label: 'Open', query: 'is:open' },
  { label: 'Mine', query: 'author:@me is:open' },
  { label: 'Needs my review', query: 'review-requested:@me is:open' },
];

// Splits a query into terms, keeping a quoted value with its qualifier:
// `label:"good first issue" bug` → ['label:"good first issue"', 'bug'].
export function tokenizeQuery(query) {
  return String(query || '').match(/(?:[^\s"]+|"[^"]*")+/g) || [];
}

const unquote = (v) => v.replace(/^"(.*)"$/, '$1');
const quote = (v) => (/\s/.test(v) ? `"${v}"` : v);

// A chip is lit while the query holds exactly its terms, in any order.
export function chipMatches(query, chipQuery) {
  const norm = (q) =>
    tokenizeQuery(q)
      .map((t) => t.toLowerCase())
      .sort()
      .join(' ');
  return norm(query) === norm(chipQuery);
}

const STATUS_TERM = /^(is|state):(open|closed|merged)$/i;
const FILTER_TERM = /^(author|assignee|label|review-requested):(.+)$/i;
// Qualifier → Filters field.
const FILTER_FIELD = {
  author: 'author',
  assignee: 'assignee',
  label: 'labels',
  'review-requested': 'reviewer',
};

// The Filters the dropdown shows for a query:
//   { status: 'open' | 'closed' | 'merged' | 'all', author, assignee,
//     reviewer, labels: [] }
// Only the first author / assignee / reviewer counts, as on GitHub; labels
// stack. Issues use assignee, PRs reviewer (review-requested:).
export function parseFilters(query) {
  const f = { status: 'all', author: '', assignee: '', reviewer: '', labels: [] };
  for (const term of tokenizeQuery(query)) {
    const s = term.match(STATUS_TERM);
    if (s) {
      f.status = s[2].toLowerCase();
      continue;
    }
    const m = term.match(FILTER_TERM);
    if (!m) continue;
    const key = FILTER_FIELD[m[1].toLowerCase()];
    const value = unquote(m[2]);
    if (key === 'labels') f.labels.push(value);
    else if (!f[key]) f[key] = value;
  }
  return f;
}

// Writes `filters` into `query`: the qualifiers they own are replaced, every
// other term (free text, sort:, is:issue…) is kept where it was.
export function applyFilters(query, filters) {
  const kept = tokenizeQuery(query).filter(
    (t) => !STATUS_TERM.test(t) && !FILTER_TERM.test(t)
  );
  const add = [];
  if (['open', 'closed', 'merged'].includes(filters.status)) {
    add.push(`is:${filters.status}`);
  }
  const author = String(filters.author || '').trim();
  const assignee = String(filters.assignee || '').trim();
  const reviewer = String(filters.reviewer || '').trim();
  if (author) add.push(`author:${quote(author)}`);
  if (assignee) add.push(`assignee:${quote(assignee)}`);
  if (reviewer) add.push(`review-requested:${quote(reviewer)}`);
  for (const label of filters.labels || []) {
    const l = String(label).trim();
    if (l) add.push(`label:${quote(l)}`);
  }
  return [...kept, ...add].join(' ');
}

// How many Filters a query applies — the count on the Filters button.
export function activeFilterCount(query) {
  const f = parseFilters(query);
  return (
    (f.status !== 'all' ? 1 : 0) +
    (f.author ? 1 : 0) +
    (f.assignee ? 1 : 0) +
    (f.reviewer ? 1 : 0) +
    f.labels.length
  );
}

// ── Linked Sessions ──────────────────────────────────────────────────────────
// Start → puts the issue on the Session it launches; while that Session is
// live, the issue's Start → becomes Open →.

const linkKey = (repo, number) => `${String(repo).toLowerCase()}#${number}`;

// Live Sessions by `repo#number`, newest first within an issue.
export function linkedSessions(sessions) {
  const map = new Map();
  const live = (sessions || [])
    .filter((s) => s.issue?.repo && s.issue?.number && !s.exited)
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  for (const s of live) {
    const key = linkKey(s.issue.repo, s.issue.number);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  }
  return map;
}

export function sessionsFor(map, item) {
  return map.get(linkKey(item.repo, item.number)) || [];
}

// ── Projects board ───────────────────────────────────────────────────────────

export const NO_STATUS = '__none__';

// Board columns from the Status field's options, in the project's order,
// with "No Status" first (as GitHub shows it) when anything lacks one.
// `field` null → a single column holding every item.
export function boardColumns(items, field) {
  if (!field) return [{ id: NO_STATUS, name: 'Items', color: null, items: [...items] }];
  const columns = field.options.map((o) => ({ ...o, items: [] }));
  const byId = new Map(columns.map((c) => [c.id, c]));
  const none = { id: NO_STATUS, name: 'No Status', color: null, items: [] };
  for (const item of items) {
    const optionId = item.values?.[field.id]?.optionId;
    (byId.get(optionId) || none).items.push(item);
  }
  return none.items.length ? [none, ...columns] : columns;
}

// GitHub's named project colours → swatches that read on both themes.
const PROJECT_COLORS = {
  GRAY: '#8b949e',
  BLUE: '#4493f8',
  GREEN: '#3fb950',
  YELLOW: '#d29922',
  ORANGE: '#db6d28',
  RED: '#f85149',
  PINK: '#db61a2',
  PURPLE: '#ab7df8',
};

export function projectColor(name) {
  return PROJECT_COLORS[String(name || '').toUpperCase()] || null;
}

// A card moved to another Status column, before GitHub confirms it: the
// item's value for `fieldId` becomes `option` (null → No Status). Returns
// a new board; the caller keeps the old one to roll back to.
export function moveItem(board, itemId, fieldId, option) {
  return {
    ...board,
    items: board.items.map((item) => {
      if (item.id !== itemId) return item;
      const values = { ...item.values };
      if (option) values[fieldId] = { text: option.name, optionId: option.id };
      else delete values[fieldId];
      return { ...item, values };
    }),
  };
}
