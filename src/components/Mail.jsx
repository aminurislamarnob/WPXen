import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Mail as MailIcon,
  MailOpen,
  Search,
  RefreshCw,
  Trash2,
  ExternalLink,
  Play,
  Loader,
  CheckCircle,
  XCircle,
  Download,
  Paperclip,
  Inbox,
  FileText,
  Code2,
} from 'lucide-react';

const PAGE_SIZE = 50;

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatFullDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function addressLabel(addr) {
  if (!addr) return '';
  return addr.Name ? `${addr.Name} <${addr.Address}>` : addr.Address;
}

function addressListLabel(list) {
  return (list || []).map(addressLabel).join(', ');
}

// ─── Setup / install card (shown until Mailpit is installed) ────────────────

function InstallCard({ onInstalled }) {
  const [installing, setInstalling] = useState(false);
  const [lines, setLines] = useState([]);
  const [error, setError] = useState(null);
  const logRef = useRef(null);

  useEffect(() => {
    window.electronAPI.on('mailpit-install-progress', ({ line }) => {
      setLines((prev) => [...prev.slice(-200), line]);
    });
    return () => window.electronAPI.off('mailpit-install-progress');
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  async function handleInstall() {
    setInstalling(true);
    setError(null);
    setLines([]);
    const result = await window.electronAPI.installMailpit();
    setInstalling(false);
    if (result.success) {
      onInstalled();
    } else {
      setError(result.error || 'Installation failed.');
    }
  }

  return (
    <div className="bg-white rounded-xl border border-surface-border shadow-card p-8 text-center">
      <div className="w-14 h-14 rounded-2xl bg-rose-50 flex items-center justify-center mx-auto mb-4">
        <MailIcon size={26} className="text-rose-500" />
      </div>
      <h2 className="text-base font-semibold text-gray-900 mb-1">
        Catch outgoing email with Mailpit
      </h2>
      <p className="text-sm text-gray-500 max-w-md mx-auto mb-5">
        Mailpit captures every email your WordPress sites send — password
        resets, form notifications, WooCommerce receipts — so nothing ever
        leaves your machine. No plugin needed.
      </p>
      <button onClick={handleInstall} disabled={installing} className="btn-primary text-sm">
        {installing ? (
          <Loader size={13} className="animate-spin mr-1.5" />
        ) : (
          <Download size={13} className="mr-1.5" />
        )}
        {installing ? 'Installing…' : 'Install Mailpit'}
      </button>
      <p className="text-xs text-gray-300 font-mono mt-3">brew install mailpit</p>

      {error && (
        <div className="flex items-center justify-center gap-2 mt-4 text-sm text-red-600">
          <XCircle size={14} /> {error}
        </div>
      )}
      {lines.length > 0 && (
        <div
          ref={logRef}
          className="mt-4 bg-gray-900 rounded-lg text-left text-xs text-gray-300 font-mono p-3 max-h-40 overflow-y-auto"
        >
          {lines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Message viewer (right pane) ────────────────────────────────────────────

function MessageViewer({ message, loading, onDelete }) {
  const [view, setView] = useState('html'); // 'html' | 'text'

  useEffect(() => {
    setView(message?.HTML ? 'html' : 'text');
  }, [message?.ID]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400">
        <Loader size={18} className="animate-spin" />
      </div>
    );
  }
  if (!message) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-gray-300 gap-2">
        <MailOpen size={28} />
        <p className="text-sm">Select a message to read it</p>
      </div>
    );
  }

  const hasHtml = !!message.HTML;
  const hasText = !!message.Text;

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Header */}
      <div className="px-5 py-4 border-b border-surface-border">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-semibold text-gray-900 break-words">
            {message.Subject || '(no subject)'}
          </h2>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => window.electronAPI.openMailpit(message.ID)}
              title="Open in Mailpit"
              className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 transition-colors"
            >
              <ExternalLink size={14} />
            </button>
            <button
              onClick={() => onDelete(message.ID)}
              title="Delete message"
              className="p-2 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-600 transition-colors"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
        <div className="mt-2 space-y-0.5 text-xs text-gray-500">
          <p>
            <span className="text-gray-400 inline-block w-10">From</span>
            {addressLabel(message.From)}
          </p>
          <p>
            <span className="text-gray-400 inline-block w-10">To</span>
            {addressListLabel(message.To)}
          </p>
          {message.Cc?.length > 0 && (
            <p>
              <span className="text-gray-400 inline-block w-10">Cc</span>
              {addressListLabel(message.Cc)}
            </p>
          )}
          <p>
            <span className="text-gray-400 inline-block w-10">Date</span>
            {formatFullDate(message.Date)}
          </p>
        </div>
        {message.Attachments?.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {message.Attachments.map((a) => (
              <span
                key={a.PartID}
                className="inline-flex items-center gap-1 bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded-md"
              >
                <Paperclip size={11} />
                {a.FileName || a.ContentType} · {formatSize(a.Size)}
              </span>
            ))}
          </div>
        )}
        {/* HTML / Text switch */}
        {hasHtml && hasText && (
          <div className="flex gap-1 mt-3">
            <button
              onClick={() => setView('html')}
              className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors ${
                view === 'html'
                  ? 'bg-gray-900 text-white'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
              }`}
            >
              <Code2 size={11} /> HTML
            </button>
            <button
              onClick={() => setView('text')}
              className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors ${
                view === 'text'
                  ? 'bg-gray-900 text-white'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
              }`}
            >
              <FileText size={11} /> Text
            </button>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 bg-white">
        {view === 'html' && hasHtml ? (
          // sandbox="" disables scripts/forms in the email; srcDoc keeps it
          // fully local (remote images are additionally blocked by the CSP).
          <iframe
            title="Email preview"
            sandbox=""
            srcDoc={message.HTML}
            className="w-full h-full border-0"
          />
        ) : (
          <pre className="p-5 text-xs text-gray-700 whitespace-pre-wrap break-words font-sans overflow-y-auto h-full">
            {message.Text || '(empty message body)'}
          </pre>
        )}
      </div>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function Mail({ refreshStatus }) {
  const [status, setStatus] = useState(null); // { installed, running, catching }
  const [inbox, setInbox] = useState(null); // API list response
  const [messages, setMessages] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(null); // 'start' | 'toggle' | 'delete-all' | 'read-all' | 'more'
  const [message, setMessage] = useState(null); // toast {type, text}
  const searchRef = useRef(search);
  searchRef.current = search;

  const loadStatus = useCallback(async () => {
    const s = await window.electronAPI.getMailpitStatus();
    setStatus(s);
    return s;
  }, []);

  // Fetches the first page for the current search term. Silent refreshes keep
  // stale data on error (e.g. Mailpit restarting) instead of flashing.
  const loadInbox = useCallback(async ({ silent = false } = {}) => {
    const result = await window.electronAPI.getMailMessages({
      limit: PAGE_SIZE,
      start: 0,
      search: searchRef.current,
    });
    if (result.success) {
      setInbox(result.data);
      setMessages(result.data.Messages || []);
    } else if (!silent) {
      setMessage({ type: 'error', text: result.error });
    }
  }, []);

  // Initial load + light polling so new mail appears while the page is open.
  useEffect(() => {
    let cancelled = false;
    async function init() {
      const s = await loadStatus();
      if (!cancelled && s.installed && s.running) await loadInbox({ silent: true });
    }
    init();
    const timer = setInterval(async () => {
      if (cancelled) return;
      const s = await loadStatus();
      if (!cancelled && s.installed && s.running) await loadInbox({ silent: true });
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [loadStatus, loadInbox]);

  // Re-query when the search term settles.
  useEffect(() => {
    if (!status?.installed || !status?.running) return;
    const t = setTimeout(() => loadInbox(), 300);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  async function openMessage(id) {
    setSelectedId(id);
    setDetailLoading(true);
    const result = await window.electronAPI.getMailMessage(id);
    setDetailLoading(false);
    if (result.success) {
      setDetail(result.message);
      // Viewing marks it read server-side; mirror that in the list.
      setMessages((prev) => prev.map((m) => (m.ID === id ? { ...m, Read: true } : m)));
    } else {
      setDetail(null);
      setMessage({ type: 'error', text: result.error });
    }
  }

  async function handleStart() {
    setBusy('start');
    setMessage(null);
    const result = await window.electronAPI.startService('mailpit');
    if (!result.success) {
      setMessage({ type: 'error', text: result.error });
    } else {
      // start-service resolves once Mailpit's API answers (readyProbe).
      await loadStatus();
      await loadInbox({ silent: true });
      refreshStatus?.();
    }
    setBusy(null);
  }

  async function handleToggleCatching() {
    if (!status) return;
    setBusy('toggle');
    setMessage(null);
    const result = await window.electronAPI.setMailCatching(!status.catching);
    if (result.success) {
      await loadStatus();
      setMessage({
        type: 'success',
        text: !status.catching
          ? 'Mail catching enabled — all sites now deliver to Mailpit.'
          : 'Mail catching disabled — PHP mail() behaves as before.',
      });
    } else {
      setMessage({ type: 'error', text: result.error });
    }
    setBusy(null);
  }

  async function handleDelete(id) {
    const result = await window.electronAPI.deleteMailMessages([id]);
    if (result.success) {
      if (selectedId === id) {
        setSelectedId(null);
        setDetail(null);
      }
      await loadInbox({ silent: true });
    } else {
      setMessage({ type: 'error', text: result.error });
    }
  }

  async function handleDeleteAll() {
    if (!window.confirm('Delete all captured messages? This cannot be undone.')) return;
    setBusy('delete-all');
    const result = await window.electronAPI.deleteMailMessages([]);
    if (result.success) {
      setSelectedId(null);
      setDetail(null);
      await loadInbox();
    } else {
      setMessage({ type: 'error', text: result.error });
    }
    setBusy(null);
  }

  async function handleMarkAllRead() {
    setBusy('read-all');
    const result = await window.electronAPI.markMailRead();
    if (result.success) {
      await loadInbox({ silent: true });
    } else {
      setMessage({ type: 'error', text: result.error });
    }
    setBusy(null);
  }

  async function handleLoadMore() {
    setBusy('more');
    const result = await window.electronAPI.getMailMessages({
      limit: PAGE_SIZE,
      start: messages.length,
      search: searchRef.current,
    });
    if (result.success) {
      setInbox(result.data);
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.ID));
        return [...prev, ...(result.data.Messages || []).filter((m) => !seen.has(m.ID))];
      });
    } else {
      setMessage({ type: 'error', text: result.error });
    }
    setBusy(null);
  }

  if (!status) {
    return (
      <div className="p-6 flex items-center gap-2 text-sm text-gray-400">
        <Loader size={14} className="animate-spin" /> Checking Mailpit…
      </div>
    );
  }

  const total = inbox?.Total ?? 0;
  const unread = inbox?.Unread ?? 0;
  // Searches report their match count as MessagesCount; plain listings as Total.
  const matchTotal = inbox?.MessagesCount ?? total;
  const hasMore = messages.length < (search.trim() ? matchTotal : total);

  return (
    <div className="p-6 h-full flex flex-col animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-shrink-0">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Mail</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {status.installed
              ? `${total} message${total === 1 ? '' : 's'} captured${
                  unread > 0 ? ` · ${unread} unread` : ''
                }`
              : 'Capture outgoing email from your sites'}
          </p>
        </div>
        {status.installed && (
          <button
            onClick={() => window.electronAPI.openMailpit()}
            className="btn-secondary text-sm"
            title="Open the full Mailpit web UI"
          >
            <ExternalLink size={13} className="mr-1.5" />
            Open Mailpit UI
          </button>
        )}
      </div>

      {/* Toast */}
      {message && (
        <div
          className={`flex items-center gap-2 px-4 py-3 rounded-xl mb-4 text-sm animate-fade-in flex-shrink-0 ${
            message.type === 'error' ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'
          }`}
        >
          {message.type === 'error' ? <XCircle size={15} /> : <CheckCircle size={15} />}
          {message.text}
        </div>
      )}

      {!status.installed ? (
        <InstallCard
          onInstalled={async () => {
            await loadStatus();
            setMessage({
              type: 'success',
              text: 'Mailpit installed. Start it and enable mail catching below.',
            });
          }}
        />
      ) : (
        <>
          {/* Not running banner */}
          {!status.running && (
            <div className="flex items-center justify-between bg-amber-50 rounded-xl px-4 py-3 mb-4 flex-shrink-0">
              <p className="text-sm text-amber-700">
                Mailpit is installed but not running — start it to view and capture mail.
              </p>
              <button
                onClick={handleStart}
                disabled={busy === 'start'}
                className="service-toggle bg-green-50 text-green-700 hover:bg-green-100 flex-shrink-0"
              >
                {busy === 'start' ? (
                  <Loader size={11} className="animate-spin mr-1.5 inline" />
                ) : (
                  <Play size={11} className="mr-1.5 inline" />
                )}
                Start
              </button>
            </div>
          )}

          {/* Catch toggle */}
          <div className="flex items-center justify-between bg-white rounded-xl border border-surface-border shadow-card px-4 py-3 mb-4 flex-shrink-0">
            <div className="min-w-0 pr-4">
              <p className="text-sm font-medium text-gray-900">Catch outgoing email</p>
              <p className="text-xs text-gray-400 mt-0.5">
                Routes PHP <span className="font-mono">mail()</span> — and therefore{' '}
                <span className="font-mono">wp_mail()</span> — from every site into Mailpit.
                No mail leaves your machine while this is on.
              </p>
            </div>
            <button
              onClick={handleToggleCatching}
              disabled={busy === 'toggle'}
              role="switch"
              aria-checked={status.catching}
              className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${
                status.catching ? 'bg-wp-green' : 'bg-gray-200'
              } ${busy === 'toggle' ? 'opacity-50' : ''}`}
            >
              <span
                className={`absolute left-0 top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                  status.catching ? 'translate-x-[18px]' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          {/* Inbox */}
          {status.running && (
            <div className="flex-1 min-h-0 flex flex-col bg-white rounded-xl border border-surface-border shadow-card overflow-hidden">
              {/* Toolbar */}
              <div className="flex items-center gap-2 px-4 py-3 border-b border-surface-border flex-shrink-0">
                <div className="relative flex-1 max-w-xs">
                  <Search
                    size={13}
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-300"
                  />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search messages…"
                    className="w-full pl-8 pr-3 py-1.5 text-sm bg-gray-50 border border-surface-border rounded-lg focus:outline-none focus:ring-1 focus:ring-gray-300"
                  />
                </div>
                <div className="flex-1" />
                <button
                  onClick={() => loadInbox()}
                  title="Refresh"
                  className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 transition-colors"
                >
                  <RefreshCw size={14} />
                </button>
                <button
                  onClick={handleMarkAllRead}
                  disabled={busy === 'read-all' || unread === 0}
                  title="Mark all as read"
                  className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 disabled:opacity-30 transition-colors"
                >
                  <MailOpen size={14} />
                </button>
                <button
                  onClick={handleDeleteAll}
                  disabled={busy === 'delete-all' || total === 0}
                  title="Delete all messages"
                  className="p-2 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-600 disabled:opacity-30 transition-colors"
                >
                  {busy === 'delete-all' ? (
                    <Loader size={14} className="animate-spin" />
                  ) : (
                    <Trash2 size={14} />
                  )}
                </button>
              </div>

              {/* List + viewer */}
              <div className="flex-1 min-h-0 flex">
                {/* Message list */}
                <div className="w-72 lg:w-80 border-r border-surface-border overflow-y-auto flex-shrink-0">
                  {messages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-2 text-gray-300 py-16">
                      <Inbox size={26} />
                      <p className="text-sm">
                        {search.trim() ? 'No messages match your search' : 'No mail captured yet'}
                      </p>
                      {!search.trim() && status.catching && (
                        <p className="text-xs text-gray-300 px-6 text-center">
                          Trigger an email from a site (e.g. a password reset) and it will
                          appear here.
                        </p>
                      )}
                    </div>
                  ) : (
                    <>
                      {messages.map((m) => (
                        <button
                          key={m.ID}
                          onClick={() => openMessage(m.ID)}
                          className={`w-full text-left px-4 py-3 border-b border-surface-border/60 transition-colors ${
                            selectedId === m.ID ? 'bg-gray-50' : 'hover:bg-gray-50/60'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            {!m.Read && (
                              <span className="w-2 h-2 rounded-full bg-wp-blue flex-shrink-0" />
                            )}
                            <span
                              className={`text-xs truncate flex-1 ${
                                m.Read ? 'text-gray-500' : 'text-gray-900 font-semibold'
                              }`}
                            >
                              {addressListLabel(m.To) || '(no recipient)'}
                            </span>
                            <span className="text-[11px] text-gray-300 flex-shrink-0">
                              {formatDate(m.Created)}
                            </span>
                          </div>
                          <p
                            className={`text-xs truncate mt-0.5 ${
                              m.Read ? 'text-gray-400' : 'text-gray-700 font-medium'
                            }`}
                          >
                            {m.Subject || '(no subject)'}
                            {m.Attachments > 0 && (
                              <Paperclip size={10} className="inline ml-1 text-gray-300" />
                            )}
                          </p>
                          <p className="text-[11px] text-gray-300 truncate mt-0.5">{m.Snippet}</p>
                        </button>
                      ))}
                      {hasMore && (
                        <button
                          onClick={handleLoadMore}
                          disabled={busy === 'more'}
                          className="w-full py-2.5 text-xs text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors"
                        >
                          {busy === 'more' ? (
                            <Loader size={12} className="animate-spin inline" />
                          ) : (
                            'Load more'
                          )}
                        </button>
                      )}
                    </>
                  )}
                </div>

                {/* Viewer */}
                <MessageViewer message={detail} loading={detailLoading} onDelete={handleDelete} />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
