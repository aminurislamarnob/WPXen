import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import {
  Loader,
  RefreshCw,
  Trash2,
  Download,
  CheckCircle,
  AlertTriangle,
  ChevronUp,
  ArrowDown,
} from 'lucide-react';
import { Button, Tooltip } from './ui';
import { prependOlder, formatLogSize } from '../lib/logView';
import { followLive, mergeLive } from '../lib/logFollow';
import { shouldStickToBottom } from '../lib/chatList';

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
  // Live follow. `followFrom` is the fresh page the watcher starts after
  // (re-set by every load, which reopens it); `followRef` the follow rule's
  // state; `marker` whether New entries shows.
  const [followFrom, setFollowFrom] = useState(null);
  const followRef = useRef({ atBottom: true, marker: false });
  const [marker, setMarker] = useState(false);
  const viewRef = useRef(null);
  const instanceRef = useRef(Math.random().toString(36).slice(2));

  const load = useCallback(
    async (kind) => {
      const request = ++requestRef.current;
      setLoading(true);
      const result = await window.electronAPI.getSiteLogPage(site.id, kind);
      if (request !== requestRef.current) return;
      if (result.success) {
        scrollRef.current = 'end';
        setView(result.page);
        applyFollow({ type: 'reset' });
        setFollowFrom({ kind, request, page: result.page });
      } else {
        setView(null);
        setMessage({ type: 'error', text: result.error });
      }
      setLoading(false);
    },
    [site.id]
  );

  function applyFollow(event) {
    const next = followLive(followRef.current, event);
    followRef.current = { atBottom: next.atBottom, marker: next.marker };
    setMarker(next.marker);
    if (next.scrollToEnd) scrollRef.current = 'end';
  }

  // While a page is shown, the main process follows its file and pushes new
  // entries; the watcher is released when the page is replaced (tab change,
  // Refresh, Clear), and when the view unmounts.
  useEffect(() => {
    if (!followFrom) return;
    const api = window.electronAPI;
    const { kind, request, page } = followFrom;
    const watchId = `${instanceRef.current}:${kind}:${request}`;
    const unsub = api.on('site-log-follow-update', (data) => {
      // A watcher for a page that's since been replaced may still deliver one.
      if (data.watchId !== watchId || request !== requestRef.current) return;
      if (data.reset) {
        setView(data.page);
        applyFollow({ type: 'reset' });
        return;
      }
      const { added } = mergeLive(viewRef.current || { entries: [] }, data);
      setView((current) => (current ? mergeLive(current, data).view : current));
      applyFollow({ type: 'entries', added });
    });
    const last = page.entries[page.entries.length - 1];
    api.followSiteLog(watchId, site.id, kind, {
      from: last ? last.offset : page.end,
      end: page.end,
    });
    return () => {
      unsub();
      api.unfollowSiteLog(watchId);
    };
  }, [followFrom, site.id]);

  function handleViewerScroll() {
    const el = viewerRef.current;
    if (!el) return;
    const atBottom = shouldStickToBottom({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
    if (atBottom !== followRef.current.atBottom)
      applyFollow({ type: 'scroll', atBottom });
  }

  function jumpToNewest() {
    applyFollow({ type: 'jump' });
    const el = viewerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    scrollRef.current = null;
  }

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
    viewRef.current = view;
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

      {/* Viewer */}
      <div className="relative">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 rounded-lg">
            <Loader size={22} className="animate-spin text-foreground" />
          </div>
        )}
        <div
          ref={viewerRef}
          onScroll={handleViewerScroll}
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
        {marker && (
          <div className="absolute bottom-3 inset-x-0 z-10 flex justify-center pointer-events-none">
            <Button onClick={jumpToNewest} className="pointer-events-auto shadow-sm">
              <ArrowDown size={13} />
              New entries
            </Button>
          </div>
        )}
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
