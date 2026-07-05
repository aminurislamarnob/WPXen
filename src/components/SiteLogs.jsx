import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Loader,
  RefreshCw,
  Trash2,
  Download,
  CheckCircle,
  AlertTriangle,
} from 'lucide-react';

const LOG_TABS = [
  { id: 'debug', label: 'Debug Log' },
  { id: 'nginx-error', label: 'Nginx Error Log' },
  { id: 'nginx-access', label: 'Nginx Access Log' },
  { id: 'php-error', label: 'PHP Error Log' },
];

export default function SiteLogs({ site }) {
  const [tab, setTab] = useState('debug');
  const [log, setLog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null); // 'clear' | 'download'
  const [message, setMessage] = useState(null);
  const viewerRef = useRef(null);

  const load = useCallback(
    async (kind) => {
      setLoading(true);
      const result = await window.electronAPI.getSiteLog(site.id, kind);
      if (result.success) {
        setLog(result.log);
      } else {
        setLog(null);
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

  // Follow the tail: scroll to the bottom whenever new content lands.
  useEffect(() => {
    const el = viewerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

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
  const hasContent = log?.exists && log.content.trim().length > 0;

  const placeholder = !log
    ? ''
    : !log.exists
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
          <h2 className="text-lg font-bold text-gray-900">Logs</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            WordPress, nginx and PHP logs for this site.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={handleClear}
            disabled={isBusy || loading || !hasContent}
            title="Clear log"
            className="btn-secondary text-sm"
          >
            {busy === 'clear' ? (
              <Loader size={14} className="animate-spin" />
            ) : (
              <Trash2 size={14} />
            )}
          </button>
          <button
            onClick={handleDownload}
            disabled={isBusy || loading || !log?.exists}
            title="Download log"
            className="btn-secondary text-sm"
          >
            {busy === 'download' ? (
              <Loader size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
          </button>
          <button
            onClick={() => {
              setMessage(null);
              load(tab);
            }}
            disabled={isBusy || loading}
            title="Refresh"
            className="btn-secondary text-sm"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {message && (
        <div
          className={`flex items-center gap-2 px-4 py-3 rounded-xl mb-4 text-sm ${
            message.type === 'error'
              ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400'
              : 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400'
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
      <div className="flex items-center gap-1 border-b border-surface-border mb-4">
        {LOG_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
              tab === t.id
                ? 'border-wp-blue text-wp-blue font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Viewer */}
      <div className="relative">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 rounded-xl">
            <Loader size={22} className="animate-spin text-white" />
          </div>
        )}
        <pre
          ref={viewerRef}
          className="w-full h-[26rem] overflow-auto font-mono text-xs leading-relaxed p-4 rounded-xl bg-zinc-900 text-zinc-100 whitespace-pre-wrap break-words select-text"
        >
          {placeholder ?? log.content}
        </pre>
      </div>

      {/* Footer info */}
      {log && (
        <div className="flex items-center justify-between mt-2">
          <p className="text-xs text-gray-400 font-mono truncate" title={log.path}>
            {log.path}
          </p>
          <p className="text-xs text-gray-400 flex-shrink-0 ml-3">
            {log.truncated
              ? 'Showing the last 256 KB'
              : log.exists
                ? `${(log.size / 1024).toFixed(1)} KB`
                : ''}
            {tab === 'php-error' ? ' • global PHP-FPM log (all sites)' : ''}
          </p>
        </div>
      )}
    </div>
  );
}
