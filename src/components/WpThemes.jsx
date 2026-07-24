import { useState, useEffect, useCallback } from 'react';
import {
  Loader,
  RefreshCw,
  Plus,
  ArrowUpCircle,
  CheckCircle,
  AlertTriangle,
  MoreVertical,
  Trash2,
  Palette,
} from 'lucide-react';
import { SegmentedTabs, Tooltip } from './ui';

const TABS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'inactive', label: 'Inactive' },
  { id: 'updates', label: 'Update Available' },
];

function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${
        checked ? 'bg-highlight' : 'bg-border'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

function StatusBadgeTheme({ status }) {
  if (status === 'active') {
    return (
      <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-status-running/10 text-status-running">
        Active
      </span>
    );
  }
  if (status === 'parent') {
    return (
      <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-highlight/10 text-highlight">
        Parent
      </span>
    );
  }
  return (
    <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground">
      Inactive
    </span>
  );
}

function RowMenu({ theme, busy, onAction, onClose }) {
  const deletable = theme.status !== 'active' && theme.status !== 'parent';
  return (
    <div
      className="absolute right-0 top-7 z-30 panel-menu p-1 w-44 animate-fade-in"
      onMouseLeave={onClose}
    >
      {theme.status !== 'active' && (
        <button
          onClick={() => onAction('activate', theme.name)}
          disabled={busy}
          className="flex w-full items-center gap-2.5 px-3 py-2 text-xs text-foreground hover:bg-accent disabled:opacity-50"
        >
          <Palette size={13} />
          Activate
        </button>
      )}
      {theme.updateAvailable && (
        <button
          onClick={() => onAction('update', theme.name)}
          disabled={busy}
          className="flex w-full items-center gap-2.5 px-3 py-2 text-xs text-foreground hover:bg-accent disabled:opacity-50"
        >
          <ArrowUpCircle size={13} />
          Update{theme.updateVersion ? ` to ${theme.updateVersion}` : ''}
        </button>
      )}
      {deletable && (
        <>
          <div className="border-t border-border my-1" />
          <button
            onClick={() => onAction('confirm-delete', theme.name)}
            disabled={busy}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            <Trash2 size={13} />
            Delete…
          </button>
        </>
      )}
      {theme.status === 'active' && !theme.updateAvailable && (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          Active theme — activate another theme to replace it.
        </p>
      )}
    </div>
  );
}

function InstallModal({ onInstall, installing, onClose }) {
  const [slug, setSlug] = useState('');
  const [activate, setActivate] = useState(false);

  return (
    <div
      className="modal-overlay animate-fade-in"
      onClick={(e) => e.target === e.currentTarget && !installing && onClose()}
    >
      <div className="sheet w-[26rem] animate-slide-in p-6">
        <h3 className="text-[15px] font-bold text-foreground">Add New Theme</h3>
        <p className="text-[13px] text-muted-foreground mt-0.5">
          Install a theme from wordpress.org
        </p>
        <div className="sheet-well mt-4">
          <label className="block text-xs font-medium text-foreground mb-1.5">
            wordpress.org theme slug
          </label>
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value.trim().toLowerCase())}
            placeholder="e.g. astra"
            autoFocus
            className="form-input font-mono text-xs"
            onKeyDown={(e) =>
              e.key === 'Enter' && slug && !installing && onInstall(slug, activate)
            }
          />
          <p className="text-xs text-muted-foreground mt-1.5">
            The slug is the last part of the theme&apos;s wordpress.org URL, e.g.{' '}
            <span className="font-mono">wordpress.org/themes/astra</span>.
          </p>
          <label className="flex items-center gap-2.5 mt-4 cursor-pointer">
            <input
              type="checkbox"
              checked={activate}
              onChange={(e) => setActivate(e.target.checked)}
              className="w-4 h-4 rounded border-border text-highlight"
            />
            <span className="text-sm text-foreground">Activate after install</span>
          </label>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} disabled={installing} className="btn-secondary">
            Cancel
          </button>
          <button
            onClick={() => onInstall(slug, activate)}
            disabled={!slug || installing}
            className="btn-primary"
          >
            {installing ? (
              <>
                <Loader size={12} className="animate-spin" />
                Installing…
              </>
            ) : (
              'Install'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteModal({ names, deleting, onConfirm, onClose }) {
  return (
    <div
      className="modal-overlay animate-fade-in"
      onClick={(e) => e.target === e.currentTarget && !deleting && onClose()}
    >
      <div className="sheet w-[420px] animate-slide-in p-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-destructive/10 flex items-center justify-center flex-shrink-0">
            <AlertTriangle size={20} className="text-destructive" />
          </div>
          <div>
            <h3 className="text-[15px] font-bold text-foreground">
              Delete theme{names.length !== 1 ? 's' : ''}
            </h3>
            <p className="text-[13px] text-muted-foreground mt-0.5">
              This removes the theme files
            </p>
          </div>
        </div>
        <p className="text-sm text-foreground mt-4 break-words">
          Delete <span className="font-semibold">{names.join(', ')}</span>?
        </p>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} disabled={deleting} className="btn-secondary">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={deleting} className="btn-danger">
            {deleting ? <Loader size={12} className="animate-spin" /> : null}
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

export default function WpThemes({ site, onSaved }) {
  const [themes, setThemes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('all');
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const [menuFor, setMenuFor] = useState(null);
  const [showInstall, setShowInstall] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = useCallback(
    async (initial = false) => {
      if (initial) setLoading(true);
      else setRefreshing(true);
      setError(null);
      const result = await window.electronAPI.getWpThemes(site.id);
      if (result.success) {
        setThemes(result.themes);
        setSelected(new Set());
      } else {
        setError(result.error);
      }
      setLoading(false);
      setRefreshing(false);
    },
    [site.id]
  );

  useEffect(() => {
    load(true);
  }, [load]);

  async function runAction(action, names, key, successText) {
    setBusy(key);
    setMessage(null);
    setMenuFor(null);
    const result = await window.electronAPI.wpThemeAction(site.id, action, names);
    if (result.success) {
      setMessage({ type: 'success', text: successText });
    } else {
      setMessage({ type: 'error', text: result.error });
    }
    await load();
    onSaved?.();
    setBusy(null);
  }

  function handleRowAction(action, name) {
    if (action === 'confirm-delete') {
      setMenuFor(null);
      setConfirmDelete([name]);
      return;
    }
    runAction(action, [name], `${action}:${name}`, `${name} ${action}d.`);
  }

  async function handleAutoUpdate(theme, enabled) {
    setBusy(`auto:${theme.name}`);
    setMessage(null);
    const result = await window.electronAPI.wpThemeAutoUpdate(
      site.id,
      theme.name,
      enabled
    );
    if (!result.success) {
      setMessage({ type: 'error', text: result.error });
    }
    await load();
    setBusy(null);
  }

  async function handleInstall(slug, activate) {
    setBusy('install');
    setMessage(null);
    const result = await window.electronAPI.wpThemeInstall(site.id, slug, activate);
    if (result.success) {
      setShowInstall(false);
      setMessage({ type: 'success', text: `${slug} installed.` });
      await load();
      onSaved?.();
    } else {
      setMessage({ type: 'error', text: result.error });
    }
    setBusy(null);
  }

  const withUpdates = themes.filter((t) => t.updateAvailable);
  const filtered = themes.filter((t) => {
    if (tab === 'active') return t.status === 'active';
    if (tab === 'inactive') return t.status !== 'active';
    if (tab === 'updates') return t.updateAvailable;
    return true;
  });

  const tabCount = (id) =>
    id === 'all'
      ? themes.length
      : id === 'active'
        ? themes.filter((t) => t.status === 'active').length
        : id === 'inactive'
          ? themes.filter((t) => t.status !== 'active').length
          : withUpdates.length;

  // Only non-active themes are bulk-selectable (delete/update targets).
  const allChecked = filtered.length > 0 && filtered.every((t) => selected.has(t.name));

  function toggleAll() {
    setSelected(() => {
      if (allChecked) return new Set();
      return new Set(filtered.map((t) => t.name));
    });
  }

  function toggleOne(name) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const selectedNames = [...selected];
  const isBusy = !!busy;

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-5">
        <div>
          <h2 className="text-lg font-bold text-foreground">Themes</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage this site&apos;s themes via WP-CLI.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => setShowInstall(true)}
            disabled={isBusy}
            className="btn-secondary text-sm"
          >
            <Plus size={14} className="mr-1.5" />
            Add New
          </button>
          <Tooltip label="Refresh">
            <button
              onClick={() => {
                setMessage(null);
                load();
              }}
              disabled={loading || refreshing || isBusy}
              aria-label="Refresh"
              className="btn-secondary text-sm"
            >
              <RefreshCw
                size={14}
                className={loading || refreshing ? 'animate-spin' : ''}
              />
            </button>
          </Tooltip>
          {withUpdates.length > 0 && (
            <button
              onClick={() =>
                runAction(
                  'update',
                  withUpdates.map((t) => t.name),
                  '__update-all__',
                  'All themes updated.'
                )
              }
              disabled={isBusy}
              className="btn-primary text-sm"
            >
              {busy === '__update-all__' ? (
                <>
                  <Loader size={14} className="animate-spin mr-1.5" />
                  Updating…
                </>
              ) : (
                <>
                  <ArrowUpCircle size={14} className="mr-1.5" />
                  Update all themes
                </>
              )}
            </button>
          )}
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
      <SegmentedTabs
        className="mb-4"
        value={tab}
        onChange={setTab}
        tabs={TABS.map((t) => ({
          value: t.id,
          label: (
            <>
              {t.label}
              <span className="text-xs opacity-60">{tabCount(t.id)}</span>
            </>
          ),
        }))}
      />

      {/* Bulk bar */}
      {selectedNames.length > 0 && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-highlight/5 border border-highlight/20 rounded-xl mb-4 text-sm animate-fade-in">
          <span className="text-highlight font-medium">
            {selectedNames.length} selected
          </span>
          <div className="flex-1" />
          <button
            onClick={() =>
              runAction('update', selectedNames, '__bulk__', 'Themes updated.')
            }
            disabled={isBusy}
            className="btn-secondary text-xs"
          >
            Update
          </button>
          <button
            onClick={() => setConfirmDelete(selectedNames)}
            disabled={isBusy}
            className="btn-danger text-xs"
          >
            Delete
          </button>
          {busy === '__bulk__' && (
            <Loader size={14} className="animate-spin text-highlight" />
          )}
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader size={22} className="animate-spin text-highlight" />
        </div>
      ) : error ? (
        <div className="bg-destructive/10 text-destructive rounded-xl px-4 py-3 text-sm">
          <p>{error}</p>
          <button onClick={() => load(true)} className="btn-secondary text-xs mt-3">
            Try again
          </button>
        </div>
      ) : (
        <div className="settings-card">
          {/* Table head */}
          <div className="flex items-center gap-3 px-5 py-2.5 bg-muted rounded-t-xl text-xs text-muted-foreground uppercase tracking-wide">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={toggleAll}
              className="w-4 h-4 rounded border-border text-highlight"
            />
            <span className="flex-1 font-medium">Theme</span>
            <span className="w-20 font-medium">Status</span>
            <span className="w-28 font-medium">Auto Update</span>
            <span className="w-6" />
          </div>

          {filtered.length === 0 ? (
            <p className="px-5 py-8 text-sm text-muted-foreground text-center">
              No themes in this view.
            </p>
          ) : (
            filtered.map((t) => {
              const rowBusy =
                busy === `auto:${t.name}` ||
                (typeof busy === 'string' && busy.endsWith(`:${t.name}`));
              return (
                <div
                  key={t.name}
                  className="flex items-center gap-3 px-5 py-3.5 border-t border-border"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(t.name)}
                    onChange={() => toggleOne(t.name)}
                    className="w-4 h-4 rounded border-border text-highlight"
                  />

                  <div className="w-9 h-9 rounded-lg bg-status-running/10 text-status-running flex items-center justify-center text-sm font-bold flex-shrink-0">
                    {t.title.charAt(0).toUpperCase()}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-semibold text-foreground truncate">
                        {t.title}
                      </h4>
                      {t.updateAvailable && (
                        <span className="flex-shrink-0 flex items-center gap-1 px-2 py-0.5 bg-status-warning/10 text-status-warning rounded-full text-[10px] font-medium">
                          <ArrowUpCircle size={10} />
                          {t.updateVersion || 'update'}
                        </span>
                      )}
                    </div>
                    {t.description && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {t.description}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                      {t.author ? `By ${t.author} • ` : ''}Version {t.version}
                    </p>
                  </div>

                  <div className="w-20 flex-shrink-0">
                    <StatusBadgeTheme status={t.status} />
                  </div>

                  <div className="w-28 flex-shrink-0 flex items-center gap-2">
                    <Toggle
                      checked={t.autoUpdate}
                      onChange={(v) => handleAutoUpdate(t, v)}
                      disabled={isBusy}
                    />
                    {busy === `auto:${t.name}` && (
                      <Loader size={12} className="animate-spin text-muted-foreground" />
                    )}
                  </div>

                  <div className="w-6 flex-shrink-0 relative">
                    {rowBusy && busy !== `auto:${t.name}` ? (
                      <Loader size={14} className="animate-spin text-highlight" />
                    ) : (
                      <button
                        onClick={() => setMenuFor((m) => (m === t.name ? null : t.name))}
                        disabled={isBusy}
                        className="p-1 rounded-lg text-muted-foreground hover:bg-accent hover:text-muted-foreground disabled:opacity-50"
                      >
                        <MoreVertical size={15} />
                      </button>
                    )}
                    {menuFor === t.name && (
                      <RowMenu
                        theme={t}
                        busy={isBusy}
                        onAction={handleRowAction}
                        onClose={() => setMenuFor(null)}
                      />
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Modals */}
      {showInstall && (
        <InstallModal
          onInstall={handleInstall}
          installing={busy === 'install'}
          onClose={() => setShowInstall(false)}
        />
      )}
      {confirmDelete && (
        <DeleteModal
          names={confirmDelete}
          deleting={busy === '__delete__'}
          onConfirm={async () => {
            await runAction(
              'delete',
              confirmDelete,
              '__delete__',
              `Deleted ${confirmDelete.join(', ')}.`
            );
            setConfirmDelete(null);
          }}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
