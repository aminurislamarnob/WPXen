import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import {
  Loader,
  RefreshCw,
  Trash2,
  Download,
  CheckCircle,
  AlertTriangle,
  ChevronUp,
} from 'lucide-react';
import { Button, Tooltip } from './ui';
import {
  prependOlder,
  formatLogSize,
  FILTER_LEVELS,
  hasLevelFilters,
  visibleLevels,
  toggleHiddenLevel,
  readHiddenLevels,
  saveHiddenLevels,
} from '../lib/logView';

// A filtered page that comes back empty only means the level is rare in
// that stretch of the file, so a load keeps reading back this many pages
// (16 MB each) before showing "none yet" with Load older.
const FILTERED_PAGE_TRIES = 8;

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

// The colored dot on each level filter, matching its badge.
const LEVEL_DOTS = {
  fatal: 'bg-destructive',
  warning: 'bg-status-warning',
  notice: 'bg-highlight',
  deprecated: 'bg-muted-foreground',
  other: 'bg-muted-foreground/50',
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
  // Levels hidden by the filter (the error logs only), remembered per viewer.
  const [hidden, setHidden] = useState(readHiddenLevels);
  const [counts, setCounts] = useState(null); // logReader countLevels result
  const countsRequestRef = useRef(0);

  // A page ending at `end` (the newest when omitted), at the filter's levels.
  // A filtered page with nothing in it reads on further back, a few times.
  const fetchPage = useCallback(
    async (kind, end) => {
      if (!hasLevelFilters(kind)) {
        return window.electronAPI.getSiteLogPage(site.id, kind, { end });
      }
      const levels = visibleLevels(hidden);
      let result;
      for (let tries = 0; tries < FILTERED_PAGE_TRIES; tries++) {
        result = await window.electronAPI.getSiteLogPage(site.id, kind, { end, levels });
        if (!result.success || result.page.entries.length || result.page.atStart) break;
        end = result.page.pageStart;
      }
      return result;
    },
    [site.id, hidden]
  );

  const loadCounts = useCallback(
    async (kind) => {
      const request = ++countsRequestRef.current;
      setCounts(null);
      if (!hasLevelFilters(kind)) return;
      const result = await window.electronAPI.getSiteLogCounts(site.id, kind);
      if (request === countsRequestRef.current && result.success)
        setCounts(result.counts);
    },
    [site.id]
  );

  // Counts cover the whole file, independent of the filter: fetched per tab,
  // and again whenever the file is reloaded (Refresh, Clear).
  useEffect(() => {
    loadCounts(tab);
  }, [tab, loadCounts]);

  function toggleLevel(level) {
    const next = toggleHiddenLevel(hidden, level);
    setHidden(next);
    saveHiddenLevels(next);
  }

  const load = useCallback(
    async (kind) => {
      const request = ++requestRef.current;
      setLoading(true);
      const result = await fetchPage(kind);
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
    [fetchPage]
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
    const result = await fetchPage(tab, view.pageStart);
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

  async function handleClear() {
    setBusy('clear');
    setMessage(null);
    const result = await window.electronAPI.clearSiteLog(site.id, tab);
    if (result.success) {
      setMessage({ type: 'success', text: 'Log cleared.' });
      loadCounts(tab);
      await load(tab);
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
  const filtered = hasLevelFilters(tab) && hidden.length > 0;
  // A filtered page can be empty while the file isn't: what's on screen
  // only proves emptiness for an unfiltered page that reaches the start.
  const hasContent =
    !!view?.exists &&
    view.size > 0 &&
    (filtered || !view.atStart || view.entries.some((e) => e.text.trim().length > 0));

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
                loadCounts(tab);
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

      {hasLevelFilters(tab) && (
        <LevelFilters
          hidden={hidden}
          counts={counts?.counts}
          onToggle={toggleLevel}
          disabled={!view?.exists}
        />
      )}

      {/* Viewer */}
      <div className="relative">
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
              {view.entries.length === 0 && (
                <p className="px-4 py-3 text-muted-foreground">
                  {view.atStart
                    ? '-- No entries at the selected levels.'
                    : '-- No entries at the selected levels yet. Load older reads further back.'}
                </p>
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

// One toggle per level, with how many entries of it the whole file holds.
// Counts are blank until the whole-file count lands.
function LevelFilters({ hidden, counts, onToggle, disabled }) {
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 mb-3"
      role="group"
      aria-label="Levels"
    >
      {FILTER_LEVELS.map((level) => {
        const on = !hidden.includes(level);
        return (
          <button
            key={level}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onToggle(level)}
            className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-xs transition-colors disabled:opacity-50 ${
              on
                ? 'border-border bg-card text-foreground'
                : 'border-dashed border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${LEVEL_DOTS[level]} ${on ? '' : 'opacity-40'}`}
            />
            {LEVEL_BADGES[level].label}
            <span className="tabular-nums text-muted-foreground">
              {counts ? counts[level].toLocaleString() : ''}
            </span>
          </button>
        );
      })}
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
