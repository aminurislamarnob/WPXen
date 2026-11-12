import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import {
  Loader,
  RefreshCw,
  Trash2,
  Download,
  CheckCircle,
  AlertTriangle,
  ChevronUp,
  Search,
  X,
} from 'lucide-react';
import { Button, Tooltip } from './ui';
import { prependOlder, formatLogSize, matchSummary } from '../lib/logView';

const LOG_TABS = [
  { id: 'debug', label: 'Debug Log' },
  { id: 'nginx-error', label: 'Nginx Error Log' },
  { id: 'nginx-access', label: 'Nginx Access Log' },
  { id: 'php-error', label: 'PHP Error Log' },
];

// The normalised levels logReader.cjs assigns, as badges. The access log has
// no levels (`level: null`) and gets none.
const LEVEL_BADGES = {
  fatal: { label: 'Fatal', className: 'bg-destructive/10 text-destructive' },
  warning: { label: 'Warning', className: 'bg-status-warning/10 text-status-warning' },
  notice: { label: 'Notice', className: 'bg-highlight/10 text-highlight' },
  deprecated: { label: 'Deprecated', className: 'bg-muted text-muted-foreground' },
  other: { label: 'Other', className: 'bg-muted text-muted-foreground' },
};

export default function SiteLogs({ site }) {
  const [tab, setTab] = useState('debug');
  const [view, setView] = useState(null); // logReader page, grown by Load older
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [busy, setBusy] = useState(null); // 'clear' | 'download'
  const [message, setMessage] = useState(null);
  const viewerRef = useRef(null);
  // Bumped by every fresh load, so a page that lands after the tab changed
  // (or after a newer load) is dropped rather than shown under the wrong tab.
  const requestRef = useRef(0);
  // What the next layout should do with the scroll position: 'end' after a
  // fresh load, or the distance from the bottom to keep after Load older.
  const scrollRef = useRef(null);

  // Whole-file search. Results are a separate view laid over the paged one,
  // which stays mounted underneath, so clearing the search lands the reader
  // back exactly where they were.
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState(null); // searchLog batch + its `kind`
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const searchRequestRef = useRef(0);
  const resultsRef = useRef(null);
  const resultsScrollRef = useRef(null);
  const term = query.trim();

  const load = useCallback(
    async (kind) => {
      const request = ++requestRef.current;
      setLoading(true);
      const result = await window.electronAPI.getSiteLogPage(site.id, kind);
      if (request !== requestRef.current) return;
      if (result.success) {
        scrollRef.current = 'end';
        setView(result.page);
      } else {
        setView(null);
        setMessage({ type: 'error', text: result.error });
      }
      setLoading(false);
    },
    [site.id]
  );

  // Load on mount and whenever the active tab changes.
  useEffect(() => {
    setMessage(null);
    load(tab);
  }, [tab, load]);

  async function loadOlder() {
    if (!view || view.atStart || loadingOlder) return;
    const request = requestRef.current;
    setLoadingOlder(true);
    const result = await window.electronAPI.getSiteLogPage(site.id, tab, {
      end: view.pageStart,
    });
    setLoadingOlder(false);
    if (request !== requestRef.current) return;
    if (result.success) {
      const el = viewerRef.current;
      if (el) scrollRef.current = { fromBottom: el.scrollHeight - el.scrollTop };
      setView((current) => prependOlder(current, result.page));
    } else {
      setMessage({ type: 'error', text: result.error });
    }
  }

  // A fresh page opens at its newest entry; an older page is added above
  // without moving what the reader is looking at.
  useLayoutEffect(() => {
    const el = viewerRef.current;
    const intent = scrollRef.current;
    scrollRef.current = null;
    if (!el || !intent) return;
    el.scrollTop =
      intent === 'end' ? el.scrollHeight : el.scrollHeight - intent.fromBottom;
  }, [view]);

  const runSearch = useCallback(
    async (kind, text) => {
      const request = ++searchRequestRef.current;
      if (!text) {
        setSearch(null);
        setSearching(false);
        return;
      }
      setSearching(true);
      const result = await window.electronAPI.searchSiteLog(site.id, kind, text);
      if (request !== searchRequestRef.current) return;
      if (result.success) {
        resultsScrollRef.current = 'end';
        setSearch({ ...result.result, kind });
      } else {
        setSearch(null);
        setMessage({ type: 'error', text: result.error });
      }
      setSearching(false);
    },
    [site.id]
  );

  // Search as the term settles, and again on another tab. Clearing it is
  // immediate.
  useEffect(() => {
    const timer = setTimeout(() => runSearch(tab, term), term ? 250 : 0);
    return () => clearTimeout(timer);
  }, [tab, term, runSearch]);

  async function loadMoreMatches() {
    if (!search || search.atStart || loadingMore) return;
    const request = searchRequestRef.current;
    setLoadingMore(true);
    // The batch's own term, not the box's: the cursor belongs to it.
    const { kind, query: batchQuery, pageStart } = search;
    const result = await window.electronAPI.searchSiteLog(site.id, kind, batchQuery, {
      end: pageStart,
    });
    setLoadingMore(false);
    if (request !== searchRequestRef.current) return;
    if (result.success) {
      const el = resultsRef.current;
      if (el) resultsScrollRef.current = { fromBottom: el.scrollHeight - el.scrollTop };
      setSearch((current) => prependOlder(current, result.result));
    } else {
      setMessage({ type: 'error', text: result.error });
    }
  }

  // Same rule as the paged view: a fresh batch opens at its newest match,
  // older matches are added above without moving the reader.
  useLayoutEffect(() => {
    const el = resultsRef.current;
    const intent = resultsScrollRef.current;
    resultsScrollRef.current = null;
    if (!el || !intent) return;
    el.scrollTop =
      intent === 'end' ? el.scrollHeight : el.scrollHeight - intent.fromBottom;
  }, [search]);

  async function handleClear() {
    setBusy('clear');
    setMessage(null);
    const result = await window.electronAPI.clearSiteLog(site.id, tab);
    if (result.success) {
      setMessage({ type: 'success', text: 'Log cleared.' });
      await load(tab);
      if (term) await runSearch(tab, term);
    } else {
      setMessage({ type: 'error', text: result.error });
    }
    setBusy(null);
  }

  async function handleDownload() {
    setBusy('download');
    setMessage(null);
    const result = await window.electronAPI.saveSiteLog(site.id, tab);
    if (result.success && result.path) {
      setMessage({ type: 'success', text: `Saved to ${result.path}` });
    } else if (!result.success) {
      setMessage({ type: 'error', text: result.error });
    }
    setBusy(null);
  }

  const isBusy = !!busy;
  // A batch from another tab is stale until that tab's search lands.
  const searchResult = search && search.kind === tab ? search : null;
  const hasContent = !!view?.exists && view.entries.some((e) => e.text.trim().length > 0);

  const placeholder = !view
    ? ''
    : !view.exists
      ? tab === 'debug'
        ? '-- The log file does not exist yet.\n-- Enable "Debug Log" in Configurations → WP Config to start logging.'
        : '-- The log file does not exist yet.'
      : hasContent
        ? null
        : '-- The log file is empty';

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-5">
        <div>
          <h2 className="text-lg font-bold text-foreground">Logs</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            WordPress, nginx and PHP logs for this site.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Tooltip label="Clear log">
            <button
              onClick={handleClear}
              disabled={isBusy || loading || !hasContent}
              aria-label="Clear log"
              className="btn-secondary text-sm"
            >
              {busy === 'clear' ? (
                <Loader size={14} className="animate-spin" />
              ) : (
                <Trash2 size={14} />
              )}
            </button>
          </Tooltip>
          <Tooltip label="Download log">
            <button
              onClick={handleDownload}
              disabled={isBusy || loading || !view?.exists}
              aria-label="Download log"
              className="btn-secondary text-sm"
            >
              {busy === 'download' ? (
                <Loader size={14} className="animate-spin" />
              ) : (
                <Download size={14} />
              )}
            </button>
          </Tooltip>
          <Tooltip label="Refresh">
            <button
              onClick={() => {
                setMessage(null);
                load(tab);
                if (term) runSearch(tab, term);
              }}
              disabled={isBusy || loading}
              aria-label="Refresh"
              className="btn-secondary text-sm"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          </Tooltip>
        </div>
      </div>

      {message && (
        <div
          className={`flex items-center gap-2 px-4 py-3 rounded-xl mb-4 text-sm ${
            message.type === 'error'
              ? 'bg-destructive/10 text-destructive'
              : 'bg-status-running/10 text-status-running'
          }`}
        >
          {message.type === 'error' ? (
            <AlertTriangle size={15} className="flex-shrink-0" />
          ) : (
            <CheckCircle size={15} className="flex-shrink-0" />
          )}
          <span className="break-words">{message.text}</span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border mb-4">
        {LOG_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
              tab === t.id
                ? 'border-highlight text-highlight font-medium'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="flex items-center gap-3 mb-3">
        <div className="relative w-72">
          <Search
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          />
          <input
            type="text"
            aria-label="Search the whole log"
            placeholder="Search the whole log…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            className="form-input !text-xs !pl-7 !pr-7"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X size={13} />
            </button>
          )}
        </div>
        {term && (
          <p className="text-xs text-muted-foreground truncate">
            {searching ? 'Searching…' : matchSummary(searchResult)}
          </p>
        )}
      </div>

      {/* Viewer */}
      <div className="relative">
        {term && searching && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 rounded-lg">
            <Loader size={22} className="animate-spin text-foreground" />
          </div>
        )}
        {term && (
          <div
            ref={resultsRef}
            className="absolute inset-0 z-[5] overflow-auto font-mono text-xs leading-relaxed rounded-lg border border-border bg-background text-foreground select-text scrollbar-thin"
          >
            {!searchResult ? null : !searchResult.exists ? (
              <pre className="p-4 whitespace-pre-wrap break-words">
                -- The log file does not exist yet.
              </pre>
            ) : searchResult.entries.length === 0 ? (
              <pre className="p-4 whitespace-pre-wrap break-words">
                {`-- No entries match "${term}".`}
              </pre>
            ) : (
              <>
                {!searchResult.atStart && (
                  <div className="flex justify-center py-2 border-b border-border">
                    <Button
                      variant="ghost"
                      onClick={loadMoreMatches}
                      disabled={loadingMore}
                    >
                      {loadingMore ? (
                        <Loader size={13} className="animate-spin" />
                      ) : (
                        <ChevronUp size={13} />
                      )}
                      Load more matches
                    </Button>
                  </div>
                )}
                <ol className="divide-y divide-border">
                  {searchResult.entries.map((entry) => (
                    <LogEntry key={entry.offset} entry={entry} />
                  ))}
                </ol>
              </>
            )}
          </div>
        )}
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 rounded-lg">
            <Loader size={22} className="animate-spin text-foreground" />
          </div>
        )}
        <div
          ref={viewerRef}
          className="w-full h-[26rem] overflow-auto font-mono text-xs leading-relaxed rounded-lg border border-border bg-background text-foreground select-text scrollbar-thin"
        >
          {placeholder !== null ? (
            <pre className="p-4 whitespace-pre-wrap break-words">{placeholder}</pre>
          ) : (
            <>
              {!view.atStart && (
                <div className="flex justify-center py-2 border-b border-border">
                  <Button variant="ghost" onClick={loadOlder} disabled={loadingOlder}>
                    {loadingOlder ? (
                      <Loader size={13} className="animate-spin" />
                    ) : (
                      <ChevronUp size={13} />
                    )}
                    Load older
                  </Button>
                </div>
              )}
              <ol className="divide-y divide-border">
                {view.entries.map((entry) => (
                  <LogEntry key={entry.offset} entry={entry} />
                ))}
              </ol>
            </>
          )}
        </div>
      </div>

      {/* Footer info */}
      {view && (
        <div className="flex items-center justify-between mt-2">
          <p
            className="text-xs text-muted-foreground font-mono truncate"
            title={view.path}
          >
            {view.path}
          </p>
          <p className="text-xs text-muted-foreground flex-shrink-0 ml-3">
            {view.exists ? formatLogSize(view.size) : ''}
            {tab === 'php-error' ? ' • global PHP-FPM log (all sites)' : ''}
          </p>
        </div>
      )}
    </div>
  );
}

// One entry: timestamp, level badge (error logs only), then the message with
// its continuation lines — a stack trace stays under its error.
function LogEntry({ entry }) {
  const badge = entry.level ? LEVEL_BADGES[entry.level] : null;
  return (
    <li className="flex items-start gap-3 px-4 py-1.5">
      <span className="flex-shrink-0 w-48 text-muted-foreground whitespace-nowrap truncate">
        {entry.time ?? (entry.partial ? '…continued' : '')}
      </span>
      {badge && (
        <span
          className={`flex-shrink-0 w-[4.75rem] text-center rounded-sm px-1.5 text-[11px] font-sans font-medium ${badge.className}`}
        >
          {badge.label}
        </span>
      )}
      <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words">{entry.text}</pre>
    </li>
  );
}
