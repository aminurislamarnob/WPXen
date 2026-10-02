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
  Copy,
  ExternalLink,
  FolderGit2,
  MoreVertical,
  SlidersHorizontal,
  Plus,
  CircleDot,
  GitPullRequest,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { SegmentedTabs, Tooltip } from '../ui';
import { SetupBanner } from './TasksSetup';
import IssueDetails from './IssueDetails';
import NewIssueDialog from './NewIssueDialog';
import FiltersMenu from './FiltersMenu';
import { MultiPicker, Popover, StatusMenu } from './pickers';
import { useIssueMutation } from './useIssueMutation';
import { useOpenLink } from '../../lib/useOpenLink';
import { AvatarStack, LabelChip, StartButton, StateBadge, stateIcon } from './parts';
import StartDialog from './StartDialog';
import PullTable from './PullTable';
import { useAgentSessions } from '../../lib/useAgentSessions';
import {
  ALL,
  ISSUE_CHIPS,
  PR_CHIPS,
  activeFilterCount,
  chipMatches,
  linkedSessions,
  sessionsFor,
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

// Tasks — GitHub Issues and PRs for every Site with a GitHub repo, through
// the `gh` CLI (services/github.cjs). Modelled on Orca's Tasks page: a project
// picker, preset chips, a GitHub search box scoped to the selected repos, and
// one list merged across repos, newest activity first, 24 to a page. Each tab
// keeps its own query and page.
//
// Every repo is searched separately, so a failing one reports its own error
// above the list while the rest still show. A quiet refresh runs every 60 s
// while the page is visible; ↻ forces one past the main process's cache.

const SELECTION_KEY = 'wpxen.tasks.selection';
const TAB_KEY = 'wpxen.tasks.tab';

const TABS = [
  { value: 'issues', label: 'Issues', icon: CircleDot },
  { value: 'pulls', label: 'PRs', icon: GitPullRequest },
];
const TAB_VIEW = {
  issues: {
    chips: ISSUE_CHIPS,
    noun: ['issue', 'issues'],
    perRepo: 100,
    search: (opts) => window.electronAPI.tasksSearchIssues(opts),
  },
  pulls: {
    chips: PR_CHIPS,
    noun: ['pull request', 'pull requests'],
    perRepo: 50,
    search: (opts) => window.electronAPI.tasksSearchPulls(opts),
  },
};
const REFRESH_MS = 60_000;

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
  const [tab, setTab] = useState(() =>
    readStored(TAB_KEY) === 'pulls' ? 'pulls' : 'issues'
  );
  const view = TAB_VIEW[tab];
  const [query, setQuery] = useState(DEFAULT_ISSUE_QUERY);
  const [draft, setDraft] = useState(DEFAULT_ISSUE_QUERY);
  const draftRef = useRef(draft);
  draftRef.current = draft;
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
  useEffect(() => writeStored(TAB_KEY, tab), [tab]);

  // Each tab keeps its own query and page; switching stashes the one being
  // left and restores the other's.
  const tabViews = useRef({});
  const switchTab = (next) => {
    if (next === tab) return;
    tabViews.current[tab] = { query, draft, page };
    const saved = tabViews.current[next] || {
      query: DEFAULT_ISSUE_QUERY,
      draft: DEFAULT_ISSUE_QUERY,
      page: 1,
    };
    setResults(null);
    setQuery(saved.query);
    setDraft(saved.draft);
    setPage(saved.page);
    setTab(next);
  };

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

  // Only the newest search may land: a slow one from before a tab or query
  // change must not overwrite what's on screen now.
  const searchSeq = useRef(0);
  const search = useCallback(
    async ({ force = false, quiet = false } = {}) => {
      const seq = ++searchSeq.current;
      if (!ready || repos.length === 0) {
        setResults(null);
        return;
      }
      if (quiet) setRefreshing(true);
      else setLoading(true);
      try {
        const res = await TAB_VIEW[tab].search({ repos, query, force });
        if (seq === searchSeq.current) setResults(mergeResults(res?.results));
      } finally {
        if (seq === searchSeq.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    // reposKey stands in for `repos`, which is a fresh array each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready, reposKey, query, tab]
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

  // Inline Status / Assignees edits on a row: the row takes GitHub's answer
  // at once, then a quiet forced search brings the list in line.
  const rowMutation = useIssueMutation();
  const [rowPopover, setRowPopover] = useState(null); // { kind, issue, anchor }
  const applyRow = async (issue, method, opts) => {
    const res = await rowMutation.run(method, {
      repo: issue.repo,
      number: issue.number,
      ...opts,
    });
    if (!res?.issue) return;
    const row = { ...res.issue };
    delete row.body; // rows carry no body
    setResults((r) =>
      r
        ? {
            ...r,
            items: r.items.map((i) =>
              i.repo === row.repo && i.number === row.number ? { ...i, ...row } : i
            ),
          }
        : r
    );
    search({ force: true, quiet: true });
  };

  const openLink = useOpenLink();
  const [creating, setCreating] = useState(false);
  const repoOptions = tree
    .filter((o) => o.value.startsWith('repo:'))
    .map((o) => ({ repo: o.repos[0], label: o.repos[0] }));

  // Start → / Open →: live Sessions linked to an issue, and the dialog.
  const linked = linkedSessions(useAgentSessions());
  const [starting, setStarting] = useState(null); // { issue, mode? }
  const openSession = (session) =>
    navigate(`/agents/${encodeURIComponent(session.siteId)}`, {
      state: { focus: session.sessionId, nonce: Date.now() },
    });

  const [filtersAnchor, setFiltersAnchor] = useState(null);
  const [rowMenu, setRowMenu] = useState(null); // { issue, anchor }

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
          onChanged={() => search({ force: true, quiet: true })}
          linked={linked}
          onStart={(issue) => setStarting({ issue })}
          onOpenSession={openSession}
        />
      )}
      <div className={detail ? 'hidden' : undefined}>
        <div className="flex items-center gap-2 mb-3">
          <SegmentedTabs tabs={TABS} value={tab} onChange={switchTab} />
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
          {ready && tab === 'issues' && repoOptions.length > 0 && (
            <button className="btn btn-secondary" onClick={() => setCreating(true)}>
              <Plus size={14} />
              New issue
            </button>
          )}
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
            body="Tasks lists issues and PRs for Sites whose webroot, theme or plugin is a git repo with a github.com remote."
          />
        ) : (
          ready && (
            <>
              <div className="flex items-center gap-2 mb-3">
                {view.chips.map((c) => (
                  <button
                    key={c.label}
                    onClick={() => applyQuery(c.query)}
                    className={`h-8 px-3 rounded-md text-[13px] font-medium transition-colors ${
                      chipMatches(query, c.query)
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
                <button
                  className="btn btn-secondary"
                  onClick={(e) => setFiltersAnchor(e.currentTarget)}
                >
                  <SlidersHorizontal size={13} />
                  Filters
                  {activeFilterCount(query) > 0 && (
                    <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums">
                      {activeFilterCount(query)}
                    </span>
                  )}
                </button>
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
                    placeholder={`Search ${view.noun[1]} — GitHub search syntax`}
                    aria-label={`Search ${view.noun[1]}`}
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

              {tab === 'pulls' ? (
                <PullTable
                  items={paged?.items || []}
                  loading={loading && !results}
                  onOpen={(pr) => openLink(pr.url, siteIdFor(pr.repo))}
                  onMenu={(pr, anchor) => setRowMenu({ issue: pr, anchor })}
                />
              ) : (
                <IssueTable
                  items={paged?.items || []}
                  loading={loading && !results}
                  onOpen={openDetails}
                  linked={linked}
                  onStart={(issue) => setStarting({ issue })}
                  onOpenSession={openSession}
                  onEdit={(kind, issue, anchor) =>
                    kind === 'menu'
                      ? setRowMenu({ issue, anchor })
                      : setRowPopover({ kind, issue, anchor })
                  }
                />
              )}

              {results && (
                <div className="flex items-center justify-between mt-3 text-[12px] text-muted-foreground">
                  <span>
                    {results.items.length === 0
                      ? `No matching ${view.noun[1]}.`
                      : `${results.items.length} ${view.noun[results.items.length === 1 ? 0 : 1]}`}
                    {results.truncated.length > 0 &&
                      ` · showing the ${view.perRepo} most recently updated per repo — narrow the search to see more`}
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

      {rowMutation.error && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-2 rounded-md border border-border bg-popover px-3 py-2 text-[12.5px] text-destructive shadow-md">
          <AlertTriangle size={13} />
          {rowMutation.error}
          <button
            aria-label="Dismiss"
            className="text-muted-foreground hover:text-foreground"
            onClick={rowMutation.clearError}
          >
            <X size={13} />
          </button>
        </div>
      )}
      {rowPopover?.kind === 'status' && (
        <StatusMenu
          anchor={rowPopover.anchor}
          item={rowPopover.issue}
          onPick={(choice) => applyRow(rowPopover.issue, 'tasksIssueState', choice)}
          onClose={() => setRowPopover(null)}
        />
      )}
      {rowPopover?.kind === 'assignees' && (
        <MultiPicker
          kind="assignees"
          repo={rowPopover.issue.repo}
          anchor={rowPopover.anchor}
          selected={rowPopover.issue.assignees.map((a) => a.login)}
          onApply={(assignees) =>
            applyRow(rowPopover.issue, 'tasksIssueAssignees', { assignees })
          }
          onClose={() => setRowPopover(null)}
        />
      )}
      {filtersAnchor && (
        <FiltersMenu
          kind={tab === 'pulls' ? 'pr' : 'issue'}
          anchor={filtersAnchor}
          draft={draft}
          onDraft={setDraft}
          onClose={() => {
            setFiltersAnchor(null);
            applyQuery(draftRef.current);
          }}
        />
      )}
      {rowMenu && (
        <RowMenu
          issue={rowMenu.issue}
          anchor={rowMenu.anchor}
          onLink={(url) => openLink(url, siteIdFor(rowMenu.issue.repo))}
          onStartWorktree={
            rowMenu.issue.kind === 'pr'
              ? null
              : () => setStarting({ issue: rowMenu.issue, mode: 'worktree' })
          }
          onClose={() => setRowMenu(null)}
        />
      )}
      {starting && (
        <StartDialog
          issue={starting.issue}
          initialMode={starting.mode}
          onClose={() => setStarting(null)}
        />
      )}
      {creating && (
        <NewIssueDialog
          repos={repoOptions}
          defaultRepo={repos.length === 1 ? repos[0] : null}
          onLink={(url) => openLink(url)}
          onClose={() => setCreating(false)}
          onCreated={(issue) => {
            setCreating(false);
            search({ force: true, quiet: true });
            openDetails(issue);
          }}
        />
      )}
    </div>
  );
}

function IssueTable({ items, loading, onOpen, onEdit, linked, onStart, onOpenSession }) {
  const now = Date.now();
  return (
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="grid grid-cols-[64px_1fr_104px_92px_84px_72px_28px] gap-3 px-4 h-9 items-center border-b border-border text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <span>ID</span>
        <span>Title / context</span>
        <span>Assignees</span>
        <span>Status</span>
        <span>Updated</span>
        <span />
        <span />
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
            onEdit={onEdit}
            sessions={sessionsFor(linked, issue)}
            onStart={onStart}
            onOpenSession={onOpenSession}
          />
        ))
      )}
    </div>
  );
}

function RowMenu({ issue, anchor, onLink, onStartWorktree, onClose }) {
  const item = (Icon, label, fn) => (
    <button
      onClick={() => {
        onClose();
        fn();
      }}
      className="flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-[12.5px] text-foreground hover:bg-accent"
    >
      <Icon size={13} className="text-muted-foreground" />
      {label}
    </button>
  );
  return (
    <Popover anchor={anchor} onClose={onClose} width={190}>
      {item(ExternalLink, 'Open on GitHub', () => onLink(issue.url))}
      {onStartWorktree && item(FolderGit2, 'Start in a new worktree', onStartWorktree)}
      {item(Copy, 'Copy link', () =>
        navigator.clipboard?.writeText(issue.url).catch(() => {
          // clipboard unavailable — Open on GitHub still works
        })
      )}
    </Popover>
  );
}

// Opens a row's inline editor without opening the row itself.
function RowEdit({ label, onClick, children }) {
  return (
    <Tooltip label={label}>
      <button
        className="-m-1 p-1 rounded-md hover:bg-accent"
        onClick={(e) => {
          e.stopPropagation();
          onClick(e.currentTarget);
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function IssueRow({ issue, now, onOpen, onEdit, sessions, onStart, onOpenSession }) {
  const open = issue.state === 'open';
  const Icon = stateIcon(issue);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(issue)}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(issue)}
      className="grid grid-cols-[64px_1fr_104px_92px_84px_72px_28px] gap-3 px-4 py-2.5 items-center border-b border-border last:border-b-0 cursor-pointer hover:bg-accent/50"
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
      <span className="justify-self-start">
        <RowEdit label="Assignees" onClick={(a) => onEdit('assignees', issue, a)}>
          <AvatarStack people={issue.assignees} />
        </RowEdit>
      </span>
      <span className="justify-self-start">
        <RowEdit label="Status" onClick={(a) => onEdit('status', issue, a)}>
          <StateBadge item={issue} />
        </RowEdit>
      </span>
      <span className="text-[12px] text-muted-foreground">
        {timeAgo(issue.updatedAt, now)}
      </span>
      <span>
        <StartButton
          sessions={sessions}
          onStart={() => onStart(issue)}
          onOpenSession={onOpenSession}
        />
      </span>
      <RowEdit label="More" onClick={(a) => onEdit('menu', issue, a)}>
        <MoreVertical size={14} className="text-muted-foreground" />
      </RowEdit>
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
