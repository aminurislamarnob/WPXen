import { useState, useEffect } from 'react';
import {
  Archive,
  Loader,
  RotateCcw,
  Trash2,
  Folder,
  AlertTriangle,
  Plus,
} from 'lucide-react';
import { ProgressLog } from './ui';

function formatBytes(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}

function RestoreConfirmModal({ backup, onConfirm, onClose, busy }) {
  return (
    <div
      className="modal-overlay animate-fade-in"
      onClick={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="sheet w-[420px] animate-slide-in">
        <div className="p-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-red-100 dark:bg-red-500/15 flex items-center justify-center flex-shrink-0">
              <AlertTriangle size={20} className="text-red-600 dark:text-red-400" />
            </div>
            <div>
              <h3 className="text-[15px] font-bold text-gray-900">Restore Backup</h3>
              <p className="text-[13px] text-gray-500 mt-0.5">
                Restore the snapshot from{' '}
                <span className="font-semibold">{formatDate(backup.createdAt)}</span>?
                Current site files and database will be replaced.
              </p>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-5">
            <button onClick={onClose} disabled={busy} className="btn-secondary">
              Cancel
            </button>
            <button onClick={onConfirm} disabled={busy} className="btn-danger">
              {busy ? <Loader size={12} className="animate-spin" /> : null}
              Restore
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function SiteBackups({ site }) {
  const [backups, setBackups] = useState(null);
  const [busy, setBusy] = useState(false); // a backup or restore is running
  const [progressMessages, setProgressMessages] = useState([]);
  const [error, setError] = useState(null);
  const [restoring, setRestoring] = useState(null); // backup pending confirm

  async function refresh() {
    const res = await window.electronAPI.listBackups(site.id);
    if (res?.success) setBackups(res.backups);
    else setError(res?.error || 'Could not list backups.');
  }

  useEffect(() => {
    refresh();
    const onProgress = (data) => {
      if (!data || data.siteId !== site.id) return;
      setProgressMessages((prev) => [...prev, data.message]);
    };
    window.electronAPI.on('backup-progress', onProgress);
    return () => window.electronAPI.off('backup-progress');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.id]);

  async function handleCreate() {
    setBusy(true);
    setError(null);
    setProgressMessages(['Starting backup…']);
    const res = await window.electronAPI.createBackup(site.id);
    setBusy(false);
    setProgressMessages([]);
    if (!res?.success) setError(res?.error || 'Backup failed.');
    await refresh();
  }

  async function handleRestore() {
    const backup = restoring;
    setBusy(true);
    setError(null);
    setProgressMessages(['Starting restore…']);
    const res = await window.electronAPI.restoreBackup(site.id, backup.timestamp);
    setBusy(false);
    setProgressMessages([]);
    setRestoring(null);
    if (!res?.success) setError(res?.error || 'Restore failed.');
  }

  async function handleDelete(backup) {
    setError(null);
    const res = await window.electronAPI.deleteBackup(site.id, backup.timestamp);
    if (!res?.success) setError(res?.error || 'Delete failed.');
    await refresh();
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[15px] font-bold text-gray-900">Backups</h2>
        <button onClick={handleCreate} disabled={busy} className="btn-primary">
          {busy ? (
            <Loader size={12} className="animate-spin" />
          ) : (
            <Plus size={12} strokeWidth={2.5} />
          )}
          Create Backup
        </button>
      </div>

      <p className="text-xs text-gray-500 mb-4">
        Snapshots capture the full site directory and database. They live in WPHerd&apos;s
        data folder, outside the site, and can be restored at any time.
      </p>

      {busy && progressMessages.length > 0 && (
        <ProgressLog messages={progressMessages} className="mb-4" />
      )}

      {error && <p className="text-xs text-red-600 dark:text-red-400 mb-3">{error}</p>}

      {backups === null ? (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Loader size={13} className="animate-spin" />
          Loading…
        </div>
      ) : backups.length === 0 ? (
        <div className="settings-card px-6 py-10 text-center">
          <Archive size={26} className="mx-auto text-gray-300 mb-2" />
          <p className="text-[13px] text-gray-500">No backups yet.</p>
          <p className="text-xs text-gray-400 mt-1">
            Create one before risky changes — plugin updates, imports, big edits.
          </p>
        </div>
      ) : (
        <div className="settings-card divide-y divide-surface-hairline">
          {backups.map((b) => (
            <div key={b.timestamp} className="flex items-center gap-3 px-4 py-3">
              <span className="icon-tile bg-[#8e8e93] w-7 h-7 flex-shrink-0">
                <Archive size={14} />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] text-gray-900">{formatDate(b.createdAt)}</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {b.wpVersion ? `WP ${b.wpVersion}` : 'WP —'} · PHP {b.phpVersion || '—'}{' '}
                  · {formatBytes((b.filesBytes || 0) + (b.dbBytes || 0))}
                </p>
              </div>
              <button
                onClick={() => setRestoring(b)}
                disabled={busy}
                title="Restore this backup"
                className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 disabled:opacity-50"
              >
                <RotateCcw size={14} />
              </button>
              <button
                onClick={() => window.electronAPI.revealBackup(site.id, b.timestamp)}
                title="Reveal in Finder"
                className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100"
              >
                <Folder size={14} />
              </button>
              <button
                onClick={() => handleDelete(b)}
                disabled={busy}
                title="Delete backup"
                className="p-1.5 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 disabled:opacity-50"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {restoring && (
        <RestoreConfirmModal
          backup={restoring}
          busy={busy}
          onConfirm={handleRestore}
          onClose={() => setRestoring(null)}
        />
      )}
    </div>
  );
}
