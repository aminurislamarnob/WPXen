import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { SegmentedTabs, Tooltip } from '../ui';
import { SetupBanner } from './TasksSetup';
import IssueDetails from './IssueDetails';
import { AvatarStack, LabelChip, StateBadge, stateIcon } from './parts';
import {
  ALL,
  DEFAULT_ISSUE_QUERY,
  buildPickerTree,
  detailPath,
  mergeResults,
  paginate,
  parseDetailPath,
  resolveSelection,
  siteSelection,
  timeAgo,
} from '../../lib/tasks';

// Tasks — GitHub Issues for every Site with a GitHub repo, through the `gh`
// CLI (services/github.cjs). Modelled on Orca's Tasks page: a project picker,
// preset chips, a GitHub search box scoped to the selected repos, and one list
// merged across repos, newest activity first, 24 to a page.
//
// Every repo is searched separately, so a failing one reports its own error
// above the list while the rest still show. A quiet refresh runs every 60 s
// while the page is visible; ↻ forces one past the main process's cache.

const SELECTION_KEY = 'wpxen.tasks.selection';
const REFRESH_MS = 60_000;

const ISSUE_CHIPS = [{ label: 'Open', query: DEFAULT_ISSUE_QUERY }];

function readStored(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable — the picker just won't be remembered
  }
}

export default function Tasks() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const detail = parseDetailPath(useParams()['*']);
  const [preflight, setPreflight] = useState(null); // { installed, authenticated, error? }
  const [sites, setSites] = useState(null); // [{ siteId, siteName, repos }]
  const [selection, setSelection] = useState(() => readStored(SELECTION_KEY) || ALL);
  const [query, setQuery] = useState(DEFAULT_ISSUE_QUERY);
  const [draft, setDraft] = useState(DEFAULT_ISSUE_QUERY);
  const [page, setPage] = useState(1);
  const [results, setResults] = useState(null); // merged
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const listRef = useRef(null);

  const tree = useMemo(() => buildPickerTree(sites || []), [sites]);
  const option = resolveSelection(tree, selection);
  const repos = option?.repos || [];
  const reposKey = repos.join(',');

  // A Site page's "Issues" link arrives as ?site=<id>.
  useEffect(() => {
    const site = params.get('site');
    if (!site) return;
    setSelection(siteSelection(site));
    setPage(1);
    setParams({}, { replace: true });
  }, [params, setParams]);

  useEffect(() => writeStored(SELECTION_KEY, selection), [selection]);

  const loadSetup = useCallback(async ({ force = false } = {}) => {
    const api = window.electronAPI;
    const pre = await api.tasksPreflight();
    setPreflight(pre);
    if (!pre?.installed || !pre?.authenticated) return;
    setSites(await api.tasksRepos({ force }));
  }, []);

  useEffect(() => {
    loadSetup();
  }, [loadSetup]);

  const ready = preflight?.installed && preflight?.authenticated;

  const search = useCallback(
    async ({ force = false, quiet = false } = {}) => {
      if (!ready || repos.length === 0) {
        setResults(null);
        return;
      }
      if (quiet) setRefreshing(true);
      else setLoading(true);
      try {
        const res = await window.electronAPI.tasksSearchIssues({ repos, query, force });
        setResults(mergeResults(res?.results));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    // reposKey stands in for `repos`, which is a fresh array each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready, reposKey, query]
  );

  useEffect(() => {
    search();
  }, [search]);

  // Quiet refresh while the page is on screen; nothing while it's hidden.
  useEffect(() => {
    if (!ready) return undefined;
    const tick = () => {
      if (document.visibilityState === 'visible') search({ quiet: true });
    };
    const id = setInterval(tick, REFRESH_MS);
    return () => clearInterval(id);
  }, [ready, search]);

  const refresh = async () => {
    await loadSetup({ force: true });
    search({ force: true, quiet: true });
  };

  const applyQuery = (q) => {
    setQuery(q.trim());
    setDraft(q);
    setPage(1);
  };

  const choose = (value) => {
    setSelection(value);
    setPage(1);
  };

  // Details render over the list rather than replacing it: the list stays
  // mounted (hidden), so its page, query and rows are untouched, and the
  // scroll position saved on the way in is put back on the way out.
  const savedScroll = useRef(0);
  const scroller = () => listRef.current?.parentElement;
  const openDetails = (issue) => {
    savedScroll.current = scroller()?.scrollTop || 0;
    navigate(detailPath(issue));
  };
  const inDetails = !!detail;
  useLayoutEffect(() => {
    const el = scroller();
    if (el) el.scrollTop = inDetails ? 0 : savedScroll.current;
  }, [inDetails]);

  // Links inside an issue open the way Site links do; the repo's Site (if
  // the picker knows it) is what an in-app browser tab attaches to.
  const siteIdFor = (repo) =>
    tree.find((o) => o.value === `repo:${repo}`)?.siteId || null;

  const paged = results ? paginate(results.items, page) : null;
  // A new page starts at its top; the scroll container is the app's <main>.
  useEffect(() => {
    listRef.current?.scrollIntoView?.({ block: 'start' });
  }, [page]);

  return (
    <div className="px-6 pb-6 max-w-[1100px] mx-auto animate-fade-in" ref={listRef}>
      {detail && (
        <IssueDetails
          key={`${detail.repo}#${detail.number}`}
          repo={detail.repo}
          number={detail.number}
          siteId={siteIdFor(detail.repo)}
          onBack={() => navigate('/tasks')}
        />
      )}
      <div className={detail ? 'hidden' : undefined}>
        <div className="flex items-center gap-2 mb-3">
          <SegmentedTabs
            tabs={[{ value: 'issues', label: 'Issues', icon: CircleDot }]}
            value="issues"
            onChange={() => {}}
          />
          {ready && tree.length > 1 && (
            <select
              value={option?.value || ALL}
              onChange={(e) => choose(e.target.value)}
              aria-label="Project"
              className="form-input !h-8 !w-auto max-w-[280px] !py-0 text-[13px]"
            >
              {tree.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.depth ? `    ${o.label}` : o.label}
                </option>
              ))}
            </select>
          )}
          <div className="flex-1" />
          {ready && (
            <Tooltip label="Refresh">
              <button
                onClick={refresh}
                aria-label="Refresh"
                className="btn btn-secondary !px-2"
                disabled={loading}
              >
                <RefreshCw
                  size={14}
                  className={refreshing || loading ? 'animate-spin' : ''}
                />
              </button>
            </Tooltip>
          )}
        </div>

        {preflight && !ready ? (
          <SetupBanner
            preflight={preflight}
            onRetry={() => loadSetup({ force: true })}
            onReady={() => loadSetup({ force: true })}
          />
        ) : sites && tree.length <= 1 ? (
          <EmptyState
            title="No Sites with a GitHub repo"
            body="Tasks lists issues for Sites whose webroot, theme or plugin is a git repo with a github.com remote."
          />
        ) : (
          ready && (
            <>
              <div className="flex items-center gap-2 mb-3">
                {ISSUE_CHIPS.map((c) => (
                  <button
                    key={c.label}
                    onClick={() => applyQuery(c.query)}
                    className={`h-8 px-3 rounded-md text-[13px] font-medium transition-colors ${
                      query === c.query
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
                <form
                  className="relative flex-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    applyQuery(draft);
                  }}
                >
                  <Search
                    size={13}
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                  />
                  <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Search issues — GitHub search syntax"
                    aria-label="Search issues"
                    className="form-input !h-8 !pl-8 !pr-8 font-mono !text-[12px]"
                  />
                  {draft && (
                    <button
                      type="button"
                      onClick={() => applyQuery('')}
                      aria-label="Clear search"
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      <X size={13} />
                    </button>
                  )}
                </form>
              </div>

              {results?.errors.length > 0 && (
                <div className="mb-3 space-y-1">
                  {results.errors.map(({ repo, error }) => (
                    <div
                      key={repo}
                      className="flex items-center gap-2 rounded-md border border-border bg-status-warning/10 px-3 py-1.5 text-[12px]"
                    >
                      <AlertTriangle
                        size={13}
                        className="text-status-warning flex-shrink-0"
                      />
                      <span className="font-mono">{repo}</span>
                      <span className="text-muted-foreground">{error.message}</span>
                    </div>
                  ))}
                </div>
              )}

              <IssueTable
                items={paged?.items || []}
                loading={loading && !results}
                onOpen={openDetails}
              />

              {results && (
                <div className="flex items-center justify-between mt-3 text-[12px] text-muted-foreground">
                  <span>
                    {results.items.length === 0
                      ? 'No matching issues.'
                      : `${results.items.length} ${results.items.length === 1 ? 'issue' : 'issues'}`}
                    {results.truncated.length > 0 &&
                      ' · showing the 100 most recently updated per repo — narrow the search to see more'}
                  </span>
                  {paged.pageCount > 1 && (
                    <div className="flex items-center gap-1">
                      <button
                        className="btn btn-ghost !h-7 !px-2"
                        disabled={paged.page <= 1}
                        onClick={() => setPage(paged.page - 1)}
                        aria-label="Previous page"
                      >
                        <ChevronLeft size={14} />
                      </button>
                      <span className="tabular-nums">
                        {paged.page} / {paged.pageCount}
                      </span>
                      <button
                        className="btn btn-ghost !h-7 !px-2"
                        disabled={paged.page >= paged.pageCount}
                        onClick={() => setPage(paged.page + 1)}
                        aria-label="Next page"
                      >
                        <ChevronRight size={14} />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )
        )}
      </div>
    </div>
  );
}

function IssueTable({ items, loading, onOpen }) {
  const now = Date.now();
  return (
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="grid grid-cols-[72px_1fr_120px_96px_120px] gap-3 px-4 h-9 items-center border-b border-border text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <span>ID</span>
        <span>Title / context</span>
        <span>Assignees</span>
        <span>Status</span>
        <span>Updated</span>
      </div>
      {loading ? (
        <div className="px-4 py-10 text-center text-[13px] text-muted-foreground">
          Loading…
        </div>
      ) : items.length === 0 ? (
        <div className="px-4 py-10 text-center text-[13px] text-muted-foreground">
          Nothing to show.
        </div>
      ) : (
        items.map((issue) => (
          <IssueRow
            key={`${issue.repo}#${issue.number}`}
            issue={issue}
            now={now}
            onOpen={onOpen}
          />
        ))
      )}
    </div>
  );
}

function IssueRow({ issue, now, onOpen }) {
  const open = issue.state === 'open';
  const Icon = stateIcon(issue);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(issue)}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(issue)}
      className="grid grid-cols-[72px_1fr_120px_96px_120px] gap-3 px-4 py-2.5 items-center border-b border-border last:border-b-0 cursor-pointer hover:bg-accent/50"
    >
      <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground tabular-nums">
        <Icon
          size={14}
          className={open ? 'text-status-running' : 'text-muted-foreground'}
          strokeWidth={2}
        />
        #{issue.number}
      </span>
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-foreground truncate">
          {issue.title}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 text-[11.5px] text-muted-foreground min-w-0">
          <span className="truncate">{issue.author}</span>
          <span className="flex-shrink-0 rounded-sm bg-muted px-1.5 font-mono text-[10.5px]">
            {issue.repo}
          </span>
          {issue.labels.slice(0, 3).map((l) => (
            <LabelChip key={l.name} label={l} />
          ))}
        </div>
      </div>
      <AvatarStack people={issue.assignees} />
      <span>
        <StateBadge item={issue} />
      </span>
      <span className="text-[12px] text-muted-foreground">
        {timeAgo(issue.updatedAt, now)}
      </span>
    </div>
  );
}

function EmptyState({ title, body }) {
  return (
    <div className="bg-card border border-border rounded-xl shadow-sm px-6 py-10 text-center">
      <p className="text-[14px] font-medium text-foreground">{title}</p>
      <p className="mt-1 text-[12.5px] text-muted-foreground max-w-md mx-auto">{body}</p>
    </div>
  );
}
