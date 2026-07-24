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
import { SegmentedTabs, Toggle, Tooltip } from './ui';

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
    <div className="settings-card p-8 text-center">
      <div className="w-14 h-14 rounded-2xl bg-destructive/10 flex items-center justify-center mx-auto mb-4">
        <MailIcon size={26} className="text-rose-500" />
      </div>
      <h2 className="text-base font-semibold text-foreground mb-1">
        Catch outgoing email with Mailpit
      </h2>
      <p className="text-sm text-muted-foreground max-w-md mx-auto mb-5">
        Mailpit captures every email your WordPress sites send — password resets, form
        notifications, WooCommerce receipts — so nothing ever leaves your machine. No
        plugin needed.
      </p>
      <button
        onClick={handleInstall}
        disabled={installing}
        className="btn-primary text-sm"
      >
        {installing ? (
          <Loader size={13} className="animate-spin mr-1.5" />
        ) : (
          <Download size={13} className="mr-1.5" />
        )}
        {installing ? 'Installing…' : 'Install Mailpit'}
      </button>
      <p className="text-xs text-muted-foreground/50 font-mono mt-3">
        brew install mailpit
      </p>

      {error && (
        <div className="flex items-center justify-center gap-2 mt-4 text-sm text-destructive">
          <XCircle size={14} /> {error}
        </div>
      )}
      {lines.length > 0 && (
        <div
          ref={logRef}
          className="mt-4 bg-background border border-border rounded-md text-left text-xs text-muted-foreground font-mono p-3 max-h-40 overflow-y-auto scrollbar-thin"
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
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <Loader size={18} className="animate-spin" />
      </div>
    );
  }
  if (!message) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground/50 gap-2">
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
      <div className="px-5 py-4 border-b border-border">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-semibold text-foreground break-words">
            {message.Subject || '(no subject)'}
          </h2>
          <div className="flex items-center gap-1 flex-shrink-0">
            <Tooltip label="Open in Mailpit">
              <button
                onClick={() => window.electronAPI.openMailpit(message.ID)}
                aria-label="Open in Mailpit"
                className="p-2 rounded-lg hover:bg-accent text-muted-foreground transition-colors"
              >
                <ExternalLink size={14} />
              </button>
            </Tooltip>
            <Tooltip label="Delete message">
              <button
                onClick={() => onDelete(message.ID)}
                aria-label="Delete message"
                className="p-2 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
              >
                <Trash2 size={14} />
              </button>
            </Tooltip>
          </div>
        </div>
        <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
          <p>
            <span className="text-muted-foreground inline-block w-10">From</span>
            {addressLabel(message.From)}
          </p>
          <p>
            <span className="text-muted-foreground inline-block w-10">To</span>
            {addressListLabel(message.To)}
          </p>
          {message.Cc?.length > 0 && (
            <p>
              <span className="text-muted-foreground inline-block w-10">Cc</span>
              {addressListLabel(message.Cc)}
            </p>
          )}
          <p>
            <span className="text-muted-foreground inline-block w-10">Date</span>
            {formatFullDate(message.Date)}
          </p>
        </div>
        {message.Attachments?.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {message.Attachments.map((a) => (
              <span
                key={a.PartID}
                className="inline-flex items-center gap-1 bg-muted text-muted-foreground text-xs px-2 py-0.5 rounded-md"
              >
                <Paperclip size={11} />
                {a.FileName || a.ContentType} · {formatSize(a.Size)}
              </span>
            ))}
          </div>
        )}
        {/* HTML / Text switch */}
        {hasHtml && hasText && (
          <SegmentedTabs
            className="mt-3"
            value={view}
            onChange={setView}
            tabs={[
              { value: 'html', label: 'HTML', icon: Code2 },
              { value: 'text', label: 'Text', icon: FileText },
            ]}
          />
        )}
      </div>

      {/* Body — the iframe area stays white: most emails assume a light
          background and would be unreadable on a dark one. */}
      <div className={`flex-1 min-h-0 ${view === 'html' && hasHtml ? 'bg-white' : ''}`}>
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
          <pre className="p-5 text-xs text-foreground whitespace-pre-wrap break-words font-sans overflow-y-auto h-full">
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
      <div className="p-6 flex items-center gap-2 text-sm text-muted-foreground">
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
    <div className="px-6 pb-6 h-full flex flex-col animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-shrink-0">
        <p className="text-xs text-muted-foreground">
          {status.installed
            ? `${total} message${total === 1 ? '' : 's'} captured${
                unread > 0 ? ` · ${unread} unread` : ''
              }`
            : 'Capture outgoing email from your sites'}
        </p>
        {status.installed && (
          <Tooltip label="Open the full Mailpit web UI">
            <button
              onClick={() => window.electronAPI.openMailpit()}
              className="btn-secondary"
            >
              <ExternalLink size={12} strokeWidth={2.5} />
              Open Mailpit UI
            </button>
          </Tooltip>
        )}
      </div>

      {/* Toast */}
      {message && (
        <div
          className={`flex items-center gap-2 px-4 py-3 rounded-xl mb-4 text-sm animate-fade-in flex-shrink-0 ${
            message.type === 'error'
              ? 'bg-destructive/10 text-destructive'
              : 'bg-status-running/10 text-status-running'
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
            <div className="flex items-center justify-between bg-status-warning/10 rounded-xl px-4 py-3 mb-4 flex-shrink-0">
              <p className="text-sm text-status-warning">
                Mailpit is installed but not running — start it to view and capture mail.
              </p>
              <button
                onClick={handleStart}
                disabled={busy === 'start'}
                className="service-toggle bg-status-running/10 text-status-running hover:bg-status-running/20 flex-shrink-0"
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
          <div className="settings-card flex items-center justify-between px-4 py-3 mb-4 flex-shrink-0">
            <div className="min-w-0 pr-4">
              <p className="text-[13px] font-medium text-foreground">
                Catch outgoing email
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Routes PHP <span className="font-mono">mail()</span> — and therefore{' '}
                <span className="font-mono">wp_mail()</span> — from every site into
                Mailpit. No mail leaves your machine while this is on.
              </p>
            </div>
            <Toggle
              checked={!!status.catching}
              onChange={handleToggleCatching}
              disabled={busy === 'toggle'}
              label="Catch outgoing email"
            />
          </div>

          {/* Inbox */}
          {status.running && (
            <div className="flex-1 min-h-0 flex flex-col settings-card">
              {/* Toolbar */}
              <div className="flex items-center gap-2 px-4 py-3 border-b border-border flex-shrink-0">
                <div className="relative flex-1 max-w-xs">
                  <Search
                    size={13}
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50"
                  />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search messages…"
                    className="w-full pl-8 pr-3 py-1.5 text-sm bg-muted border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
                <div className="flex-1" />
                <Tooltip label="Refresh">
                  <button
                    onClick={() => loadInbox()}
                    aria-label="Refresh"
                    className="p-2 rounded-lg hover:bg-accent text-muted-foreground transition-colors"
                  >
                    <RefreshCw size={14} />
                  </button>
                </Tooltip>
                <Tooltip label="Mark all as read">
                  <button
                    onClick={handleMarkAllRead}
                    disabled={busy === 'read-all' || unread === 0}
                    aria-label="Mark all as read"
                    className="p-2 rounded-lg hover:bg-accent text-muted-foreground disabled:opacity-30 transition-colors"
                  >
                    <MailOpen size={14} />
                  </button>
                </Tooltip>
                <Tooltip label="Delete all messages">
                  <button
                    onClick={handleDeleteAll}
                    disabled={busy === 'delete-all' || total === 0}
                    aria-label="Delete all messages"
                    className="p-2 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive disabled:opacity-30 transition-colors"
                  >
                    {busy === 'delete-all' ? (
                      <Loader size={14} className="animate-spin" />
                    ) : (
                      <Trash2 size={14} />
                    )}
                  </button>
                </Tooltip>
              </div>

              {/* List + viewer */}
              <div className="flex-1 min-h-0 flex">
                {/* Message list */}
                <div className="w-72 lg:w-80 border-r border-border overflow-y-auto flex-shrink-0">
                  {messages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-2 text-muted-foreground/50 py-16">
                      <Inbox size={26} />
                      <p className="text-sm">
                        {search.trim()
                          ? 'No messages match your search'
                          : 'No mail captured yet'}
                      </p>
                      {!search.trim() && status.catching && (
                        <p className="text-xs text-muted-foreground/50 px-6 text-center">
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
                          className={`w-full text-left px-4 py-3 border-b border-border/60 transition-colors ${
                            selectedId === m.ID ? 'bg-muted' : 'hover:bg-accent/60'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            {!m.Read && (
                              <span className="w-2 h-2 rounded-full bg-highlight flex-shrink-0" />
                            )}
                            <span
                              className={`text-xs truncate flex-1 ${
                                m.Read
                                  ? 'text-muted-foreground'
                                  : 'text-foreground font-semibold'
                              }`}
                            >
                              {addressListLabel(m.To) || '(no recipient)'}
                            </span>
                            <span className="text-[11px] text-muted-foreground/50 flex-shrink-0">
                              {formatDate(m.Created)}
                            </span>
                          </div>
                          <p
                            className={`text-xs truncate mt-0.5 ${
                              m.Read
                                ? 'text-muted-foreground'
                                : 'text-foreground font-medium'
                            }`}
                          >
                            {m.Subject || '(no subject)'}
                            {m.Attachments > 0 && (
                              <Paperclip
                                size={10}
                                className="inline ml-1 text-muted-foreground/50"
                              />
                            )}
                          </p>
                          <p className="text-[11px] text-muted-foreground/50 truncate mt-0.5">
                            {m.Snippet}
                          </p>
                        </button>
                      ))}
                      {hasMore && (
                        <button
                          onClick={handleLoadMore}
                          disabled={busy === 'more'}
                          className="w-full py-2.5 text-xs text-muted-foreground hover:text-muted-foreground hover:bg-accent transition-colors"
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
                <MessageViewer
                  message={detail}
                  loading={detailLoading}
                  onDelete={handleDelete}
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
