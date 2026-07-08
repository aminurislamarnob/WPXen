import { useState, useEffect, useCallback } from 'react';
import {
  Archive,
  AlertCircle,
  Clock,
  Cloud,
  UploadCloud,
  DownloadCloud,
  Folder,
  GitBranch,
  History,
  Loader,
  Play,
  RefreshCw,
  Rocket,
  Trash2,
} from 'lucide-react';
import { Card, Row, SectionLabel, Toggle, Button, ProgressLog } from './ui';

function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const TRIGGER_LABELS = {
  manual: null, // the default — no badge noise
  scheduled: {
    text: 'Scheduled',
    cls: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  },
  'pre-restore': {
    text: 'Pre-restore',
    cls: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  },
  cloud: {
    text: 'From cloud',
    cls: 'bg-purple-50 text-purple-700 dark:bg-purple-500/10 dark:text-purple-400',
  },
};

// Destructive-restore confirmation sheet.
function RestoreConfirmModal({ site, backup, onClose, onConfirm }) {
  return (
    <div
      className="modal-overlay animate-fade-in"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="sheet w-[460px] animate-slide-in">
        <div className="px-6 pt-6 pb-6">
          <h2 className="text-[15px] font-bold text-gray-900">Restore this backup?</h2>
          <p className="text-[13px] text-gray-500 mt-2">
            All current files and the database of{' '}
            <span className="font-semibold text-gray-900">{site.name}</span> will be
            replaced with the snapshot from{' '}
            <span className="font-semibold text-gray-900">
              {formatDate(backup.createdAt)}
            </span>
            . A safety snapshot of the current state is taken first, so you can undo this
            by restoring it.
          </p>
          <div className="flex justify-end gap-2 mt-6">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="danger" onClick={onConfirm}>
              <History size={12} strokeWidth={2.5} />
              Restore
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// "Deploy" card: remote/branch config + one-click push with a streamed log.
function GitDeployCard({ site, onSaved }) {
  const [status, setStatus] = useState(null);
  const [remoteUrl, setRemoteUrl] = useState(site.gitDeploy?.remoteUrl || '');
  const [branch, setBranch] = useState(site.gitDeploy?.branch || 'main');
  const [includeDb, setIncludeDb] = useState(!!site.gitDeploy?.includeDb);
  const [busy, setBusy] = useState(null); // 'save' | 'deploy'
  const [error, setError] = useState(null);
  const [log, setLog] = useState(null);

  const refresh = useCallback(() => {
    window.electronAPI.getGitDeployStatus(site.id).then((r) => {
      if (r?.success) setStatus(r);
    });
  }, [site.id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    window.electronAPI.on('deploy-progress', ({ message }) => {
      setLog((prev) => [...(prev || []), message]);
    });
    return () => window.electronAPI.off('deploy-progress');
  }, []);

  async function handleSave() {
    setBusy('save');
    setError(null);
    const res = await window.electronAPI.configureGitDeploy(site.id, {
      remoteUrl,
      branch,
      includeDb,
    });
    setBusy(null);
    if (!res?.success) return setError(res?.error || 'Failed to configure git deploy.');
    onSaved?.();
    refresh();
  }

  async function handleDeploy() {
    setBusy('deploy');
    setError(null);
    setLog(['Starting deploy…']);
    const res = await window.electronAPI.runGitDeploy(site.id, {});
    setBusy(null);
    if (!res?.success) {
      setError(res?.error || 'Deploy failed.');
    } else {
      // The main process already streamed its final "Deploy complete." line.
      onSaved?.();
      refresh();
    }
  }

  const configured = !!site.gitDeploy?.remoteUrl;
  const dirty =
    configured &&
    (remoteUrl !== site.gitDeploy.remoteUrl ||
      branch !== site.gitDeploy.branch ||
      includeDb !== !!site.gitDeploy.includeDb);

  if (status && !status.gitInstalled) {
    return (
      <Card>
        <div className="flex items-center gap-3 px-4 py-4 text-[13px] text-gray-500">
          <GitBranch size={18} className="text-gray-400 flex-shrink-0" />
          <span>
            Git is not installed. Install the Xcode Command Line Tools (
            <span className="font-mono">xcode-select --install</span>) to deploy.
          </span>
        </div>
      </Card>
    );
  }

  return (
    <div>
      <Card>
        <Row
          icon={<GitBranch size={18} className="text-gray-400 flex-shrink-0" />}
          title="Remote URL"
          subtitle="Any git remote — GitHub, GitLab, or your own server. Uses your existing SSH keys or credential helper."
        >
          <input
            type="text"
            className="form-input font-mono !text-xs !w-64"
            value={remoteUrl}
            onChange={(e) => setRemoteUrl(e.target.value)}
            placeholder="git@github.com:you/site.git"
          />
        </Row>
        <Row title="Branch">
          <input
            type="text"
            className="form-input font-mono !text-xs !w-36"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="main"
          />
        </Row>
        <Row
          title="Include database dump"
          subtitle="Adds a fresh dump at .wpherd/database.sql to each deploy"
        >
          <Toggle checked={includeDb} onChange={setIncludeDb} label="Include database" />
        </Row>
        <Row
          title={configured ? 'Deploy' : 'Set up deploy'}
          subtitle={
            configured
              ? `${status?.dirtyCount ?? '—'} changed file${status?.dirtyCount === 1 ? '' : 's'}${
                  site.gitDeploy?.lastDeployAt
                    ? ` · last deploy ${formatDate(site.gitDeploy.lastDeployAt)}`
                    : ''
                }`
              : 'Save the remote first, then deploy'
          }
        >
          {(dirty || !configured) && (
            <Button onClick={handleSave} disabled={busy !== null || !remoteUrl.trim()}>
              {busy === 'save' ? <Loader size={12} className="animate-spin" /> : null}
              Save
            </Button>
          )}
          <Button
            variant="primary"
            onClick={handleDeploy}
            disabled={busy !== null || !configured || dirty}
          >
            {busy === 'deploy' ? (
              <Loader size={12} className="animate-spin" />
            ) : (
              <Rocket size={12} strokeWidth={2.5} />
            )}
            Deploy
          </Button>
        </Row>
      </Card>
      {log && <ProgressLog messages={log} done={busy !== 'deploy'} className="mt-3" />}
      {error && (
        <div className="mt-2 flex items-start gap-2 bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400 rounded-lg px-3 py-2.5 text-xs">
          <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
      <p className="text-[11px] text-gray-400 mt-1.5 px-1">
        <span className="font-mono">wp-config.php</span> is excluded by the generated{' '}
        <span className="font-mono">.gitignore</span> — it contains your authentication
        salts. WPHerd never stores git credentials.
      </p>
    </div>
  );
}

// Cloud archives for one connected provider: list + download.
function CloudArchives({ site, provider, onDownloaded }) {
  const [files, setFiles] = useState(null);
  const [busy, setBusy] = useState(null); // remoteName being downloaded | 'list'
  const [error, setError] = useState(null);

  async function refresh() {
    setBusy('list');
    setError(null);
    const res = await window.electronAPI.listRemoteBackups(site.id, provider.id);
    setBusy(null);
    if (!res?.success) return setError(res?.error || 'Could not list cloud archives.');
    setFiles(res.files);
  }

  async function handleDownload(remoteName) {
    setBusy(remoteName);
    setError(null);
    const res = await window.electronAPI.downloadRemoteBackup(
      site.id,
      provider.id,
      remoteName
    );
    setBusy(null);
    if (!res?.success) return setError(res?.error || 'Download failed.');
    onDownloaded?.();
    refresh();
  }

  return (
    <Card className="mt-3">
      <Row
        icon={<Cloud size={18} className="text-gray-400 flex-shrink-0" />}
        title={`${provider.name} archives`}
        subtitle={
          provider.account?.email ? `Connected as ${provider.account.email}` : undefined
        }
      >
        <Button onClick={refresh} disabled={busy === 'list'}>
          {busy === 'list' ? (
            <Loader size={12} className="animate-spin" />
          ) : (
            <RefreshCw size={12} strokeWidth={2.5} />
          )}
          {files ? 'Refresh' : 'Show'}
        </Button>
      </Row>
      {files &&
        (files.length === 0 ? (
          <div className="px-4 py-3 text-xs text-gray-500">
            No archives for this site in {provider.name} yet.
          </div>
        ) : (
          files.map((f) => (
            <Row
              key={f.name}
              title={<span className="font-mono text-xs">{f.name}</span>}
              subtitle={`${formatBytes(f.sizeBytes)} · ${formatDate(f.modifiedAt)}`}
            >
              {f.existsLocally ? (
                <span className="text-xs text-gray-400">On this Mac</span>
              ) : (
                <Button onClick={() => handleDownload(f.name)} disabled={busy !== null}>
                  {busy === f.name ? (
                    <Loader size={12} className="animate-spin" />
                  ) : (
                    <DownloadCloud size={12} strokeWidth={2.5} />
                  )}
                  Download
                </Button>
              )}
            </Row>
          ))
        ))}
      {error && (
        <p className="px-4 pb-3 text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
    </Card>
  );
}

export default function SiteBackups({ site, onSaved }) {
  const [backups, setBackups] = useState([]);
  const [providers, setProviders] = useState({});
  const [busy, setBusy] = useState(null); // 'backup' | 'restore' | backupId (delete) | `up:${backupId}`
  const [log, setLog] = useState(null);
  const [error, setError] = useState(null);
  const [confirmRestore, setConfirmRestore] = useState(null);

  const refresh = useCallback(() => {
    window.electronAPI
      .listBackups(site.id)
      .then((r) => setBackups(r?.success ? r.backups : []));
  }, [site.id]);

  useEffect(() => {
    refresh();
    window.electronAPI
      .getCloudStatus()
      .then((r) => setProviders(r?.success ? r.providers : {}))
      .catch(() => {});
  }, [refresh]);

  useEffect(() => {
    const push = ({ message }) => setLog((prev) => [...(prev || []), message]);
    window.electronAPI.on('backup-progress', push);
    window.electronAPI.on('restore-progress', push);
    return () => {
      window.electronAPI.off('backup-progress');
      window.electronAPI.off('restore-progress');
    };
  }, []);

  const connectedProviders = Object.values(providers).filter((p) => p.connected);

  async function handleBackupNow() {
    setBusy('backup');
    setError(null);
    setLog(['Starting backup…']);
    const res = await window.electronAPI.createBackup(site.id, {});
    setBusy(null);
    if (!res?.success) {
      setError(res?.error || 'Backup failed.');
      setLog(null);
    } else {
      setLog(null);
      refresh();
      onSaved?.();
    }
  }

  async function handleRestore(backup) {
    setConfirmRestore(null);
    setBusy('restore');
    setError(null);
    setLog(['Starting restore…']);
    const res = await window.electronAPI.restoreBackup(site.id, backup.id);
    setBusy(null);
    setLog(null);
    if (!res?.success) {
      setError(res?.error || 'Restore failed. The safety snapshot is in the list below.');
    }
    refresh();
    onSaved?.();
  }

  async function handleDelete(backupId) {
    setBusy(backupId);
    await window.electronAPI.deleteBackup(backupId);
    setBusy(null);
    refresh();
  }

  async function handleUpload(backupId, providerId) {
    setBusy(`up:${backupId}`);
    setError(null);
    const res = await window.electronAPI.uploadBackup(backupId, providerId);
    setBusy(null);
    if (!res?.success) setError(res?.error || 'Upload failed.');
    refresh();
  }

  async function handleScheduleChange(schedule) {
    const res = await window.electronAPI.setSiteBackupConfig(site.id, { schedule });
    if (res?.success) onSaved?.();
  }

  async function handleAutoUploadChange(providerId) {
    const res = await window.electronAPI.setSiteBackupConfig(site.id, {
      autoUpload: providerId || null,
    });
    if (res?.success) onSaved?.();
  }

  const working = busy === 'backup' || busy === 'restore';

  return (
    <div>
      <h2 className="text-[15px] font-bold text-gray-900 mb-4">Backups</h2>

      <Card className="mb-4">
        <Row
          icon={<Archive size={18} className="text-gray-400 flex-shrink-0" />}
          title="Back up this site"
          subtitle="Snapshot of all files and the database, stored on this Mac"
        >
          <Button variant="primary" onClick={handleBackupNow} disabled={working}>
            {busy === 'backup' ? (
              <Loader size={12} className="animate-spin" />
            ) : (
              <Play size={12} strokeWidth={2.5} fill="currentColor" />
            )}
            Back Up Now
          </Button>
        </Row>
        <Row
          icon={<Clock size={18} className="text-gray-400 flex-shrink-0" />}
          title="Schedule"
          subtitle="Automatic backups while WPHerd is running"
        >
          <select
            value={site.backupSchedule || ''}
            onChange={(e) => handleScheduleChange(e.target.value)}
            className="form-input !w-40 !py-1 text-[13px]"
          >
            <option value="">Default (Settings)</option>
            <option value="off">Off</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </Row>
        {connectedProviders.length > 0 && (
          <Row
            icon={<UploadCloud size={18} className="text-gray-400 flex-shrink-0" />}
            title="Auto-upload to cloud"
            subtitle="Scheduled backups are also uploaded to this provider"
          >
            <select
              value={site.cloudAutoUpload || ''}
              onChange={(e) => handleAutoUploadChange(e.target.value)}
              className="form-input !w-40 !py-1 text-[13px]"
            >
              <option value="">Off</option>
              {connectedProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Row>
        )}
      </Card>

      {working && log && <ProgressLog messages={log} className="mb-4" />}
      {error && (
        <div className="mb-4 flex items-start gap-2 bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400 rounded-lg px-3 py-2.5 text-xs">
          <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <SectionLabel>Snapshots</SectionLabel>
      <Card>
        {backups.length === 0 ? (
          <div className="flex items-center gap-3 px-4 py-5 text-[13px] text-gray-500">
            <Archive size={18} className="text-gray-400 flex-shrink-0" />
            <span>No backups yet. Click Back Up Now to create the first one.</span>
          </div>
        ) : (
          backups.map((b) => {
            const badge = TRIGGER_LABELS[b.trigger];
            const uploadedTo = Object.keys(b.uploads || {});
            return (
              <Row
                key={b.id}
                title={
                  <span className="flex items-center gap-2">
                    {formatDate(b.createdAt)}
                    {badge && (
                      <span
                        className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${badge.cls}`}
                      >
                        {badge.text}
                      </span>
                    )}
                    {uploadedTo.length > 0 && (
                      <Cloud
                        size={12}
                        className="text-wp-blue"
                        title="Uploaded to cloud"
                      />
                    )}
                  </span>
                }
                subtitle={`${formatBytes(b.sizeBytes)} · WP ${b.wpVersion} · PHP ${b.phpVersion}${
                  b.note ? ` · ${b.note}` : ''
                }`}
              >
                {connectedProviders
                  .filter((p) => !uploadedTo.includes(p.id))
                  .map((p) => (
                    <Button
                      key={p.id}
                      onClick={() => handleUpload(b.id, p.id)}
                      disabled={busy !== null}
                      title={`Upload to ${p.name}`}
                    >
                      {busy === `up:${b.id}` ? (
                        <Loader size={12} className="animate-spin" />
                      ) : (
                        <UploadCloud size={12} strokeWidth={2.5} />
                      )}
                    </Button>
                  ))}
                <Button
                  onClick={() => window.electronAPI.revealBackup(b.id)}
                  title="Reveal in Finder"
                >
                  <Folder size={12} strokeWidth={2.5} />
                </Button>
                <Button
                  onClick={() => setConfirmRestore(b)}
                  disabled={working}
                  title="Restore this snapshot"
                >
                  <History size={12} strokeWidth={2.5} />
                  Restore
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => handleDelete(b.id)}
                  disabled={busy !== null}
                  title="Delete backup"
                  className="text-gray-400 hover:text-red-600 dark:hover:text-red-400"
                >
                  {busy === b.id ? (
                    <Loader size={12} className="animate-spin" />
                  ) : (
                    <Trash2 size={12} strokeWidth={2.5} />
                  )}
                </Button>
              </Row>
            );
          })
        )}
      </Card>

      {connectedProviders.map((p) => (
        <CloudArchives key={p.id} site={site} provider={p} onDownloaded={refresh} />
      ))}

      <div className="mt-6">
        <SectionLabel>Deploy</SectionLabel>
        <GitDeployCard site={site} onSaved={onSaved} />
      </div>

      {confirmRestore && (
        <RestoreConfirmModal
          site={site}
          backup={confirmRestore}
          onClose={() => setConfirmRestore(null)}
          onConfirm={() => handleRestore(confirmRestore)}
        />
      )}
    </div>
  );
}
