import { useState, useEffect } from 'react';
import {
  GitBranch,
  GitCommitHorizontal,
  Loader,
  UploadCloud,
  Link2,
  FileDiff,
} from 'lucide-react';
import { Toggle, ProgressLog } from './ui';

export default function SiteGitDeploy({ site }) {
  const [status, setStatus] = useState(null); // git repo status
  const [gitInstalled, setGitInstalled] = useState(true);
  const [settings, setSettings] = useState(site.gitDeploy || {});
  const [error, setError] = useState(null);

  const [remoteInput, setRemoteInput] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false); // init / set-remote / deploy
  const [deployLines, setDeployLines] = useState([]);
  const [includeUploadsInit, setIncludeUploadsInit] = useState(false);

  async function refresh() {
    const res = await window.electronAPI.gitStatus(site.id);
    if (!res?.success) {
      setError(res?.error || 'Could not read git status.');
      return;
    }
    setStatus(res.status);
    setGitInstalled(res.gitInstalled);
    setSettings(res.settings);
    setRemoteInput(res.status.remoteUrl || res.settings.remoteUrl || '');
  }

  useEffect(() => {
    refresh();
    const onLine = (data) => {
      if (!data || data.siteId !== site.id) return;
      setDeployLines((prev) => [...prev, data.line]);
    };
    window.electronAPI.on('git-deploy-progress', onLine);
    return () => window.electronAPI.off('git-deploy-progress');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.id]);

  async function handleInit() {
    setBusy(true);
    setError(null);
    const res = await window.electronAPI.gitInit(site.id, {
      includeUploads: includeUploadsInit,
    });
    setBusy(false);
    if (!res?.success) setError(res?.error || 'Failed to initialize the repository.');
    await refresh();
  }

  async function handleSaveRemote() {
    setBusy(true);
    setError(null);
    const res = await window.electronAPI.gitSetRemote(site.id, remoteInput);
    setBusy(false);
    if (!res?.success) setError(res?.error || 'Failed to set the remote.');
    else await refresh();
  }

  async function handleToggleSetting(key, value) {
    setError(null);
    setSettings((prev) => ({ ...prev, [key]: value }));
    const res = await window.electronAPI.gitSetDeploySettings(site.id, { [key]: value });
    if (!res?.success) {
      setError(res?.error || 'Failed to save settings.');
      await refresh();
    }
  }

  async function handleDeploy() {
    setBusy(true);
    setError(null);
    setDeployLines(['Starting deploy…']);
    const res = await window.electronAPI.gitDeploy(site.id, message);
    setBusy(false);
    if (!res?.success) {
      setError(res?.error || 'Deploy failed.');
    } else {
      setMessage('');
      setDeployLines([]);
      setStatus(res.status);
    }
  }

  if (!gitInstalled) {
    return (
      <div>
        <h2 className="text-[15px] font-bold text-gray-900 mb-4">Deploy</h2>
        <div className="settings-card px-6 py-10 text-center">
          <GitBranch size={26} className="mx-auto text-gray-300 mb-2" />
          <p className="text-[13px] text-gray-500">
            Git is not installed. Install the Xcode Command Line Tools (
            <span className="font-mono">xcode-select --install</span>) to deploy.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-[15px] font-bold text-gray-900 mb-4">Deploy</h2>

      {status === null ? (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Loader size={13} className="animate-spin" />
          Loading…
        </div>
      ) : !status.isRepo ? (
        <div className="settings-card px-6 py-8 text-center">
          <GitBranch size={26} className="mx-auto text-gray-300 mb-2" />
          <p className="text-[13px] text-gray-500 mb-1">
            Version this site with Git and push it to any remote.
          </p>
          <p className="text-xs text-gray-400 mb-4">
            A WordPress-aware <span className="font-mono">.gitignore</span> is created —{' '}
            <span className="font-mono">wp-config.php</span> is never committed.
          </p>
          <label className="inline-flex items-center gap-2 text-xs text-gray-600 mb-4">
            <Toggle
              checked={includeUploadsInit}
              onChange={setIncludeUploadsInit}
              label="Include uploads"
            />
            Include <span className="font-mono">wp-content/uploads</span>
          </label>
          <div>
            <button onClick={handleInit} disabled={busy} className="btn-primary">
              {busy ? (
                <Loader size={12} className="animate-spin" />
              ) : (
                <GitBranch size={12} strokeWidth={2.5} />
              )}
              Initialize Git Repository
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Repo state */}
          <div className="settings-card divide-y divide-surface-hairline mb-4">
            <div className="flex items-center gap-3 px-4 py-3">
              <span className="icon-tile bg-[#ff9500] w-7 h-7 flex-shrink-0">
                <GitBranch size={14} />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] text-gray-900">
                  {status.branch === 'HEAD'
                    ? 'Detached HEAD'
                    : status.branch || 'No commits yet'}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {status.dirtyCount > 0
                    ? `${status.dirtyCount} uncommitted change${status.dirtyCount === 1 ? '' : 's'}`
                    : 'Working tree clean'}
                </p>
              </div>
            </div>
            {status.lastCommit && (
              <div className="flex items-center gap-3 px-4 py-3">
                <span className="icon-tile bg-[#8e8e93] w-7 h-7 flex-shrink-0">
                  <GitCommitHorizontal size={14} />
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] text-gray-900 truncate">
                    {status.lastCommit.subject}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5 font-mono">
                    {status.lastCommit.hash.slice(0, 7)} ·{' '}
                    {new Date(status.lastCommit.date).toLocaleString()}
                  </p>
                </div>
              </div>
            )}
            <div className="flex items-center gap-3 px-4 py-3">
              <span className="icon-tile bg-[#0a7aff] w-7 h-7 flex-shrink-0">
                <Link2 size={14} />
              </span>
              <input
                type="text"
                value={remoteInput}
                onChange={(e) => setRemoteInput(e.target.value)}
                placeholder="git@github.com:you/site.git"
                className="form-input !py-1 text-xs flex-1 min-w-0 font-mono"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <button
                onClick={handleSaveRemote}
                disabled={
                  busy || !remoteInput.trim() || remoteInput.trim() === status.remoteUrl
                }
                className="btn-secondary text-xs"
              >
                Save
              </button>
            </div>
          </div>

          {/* Deploy settings */}
          <div className="settings-card divide-y divide-surface-hairline mb-4">
            <div className="flex items-center gap-3 px-4 py-3">
              <div className="flex-1 min-w-0">
                <p className="text-[13px] text-gray-900">Include uploads</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Commit <span className="font-mono">wp-content/uploads</span> (can be
                  large)
                </p>
              </div>
              <Toggle
                checked={!!settings.includeUploads}
                onChange={(v) => handleToggleSetting('includeUploads', v)}
                label="Include uploads"
              />
            </div>
            <div className="flex items-center gap-3 px-4 py-3">
              <div className="flex-1 min-w-0">
                <p className="text-[13px] text-gray-900">Include database dump</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Write <span className="font-mono">wpherd-db.sql</span> into the repo on
                  each deploy (contains user data)
                </p>
              </div>
              <Toggle
                checked={!!settings.includeDbDump}
                onChange={(v) => handleToggleSetting('includeDbDump', v)}
                label="Include database dump"
              />
            </div>
          </div>

          {/* Commit & push */}
          <div className="settings-card p-4">
            <div className="flex items-center gap-2">
              <FileDiff size={14} className="text-gray-400 flex-shrink-0" />
              <input
                type="text"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Commit message (optional)"
                className="form-input !py-1.5 text-xs flex-1 min-w-0"
              />
              <button onClick={handleDeploy} disabled={busy} className="btn-primary">
                {busy ? (
                  <Loader size={12} className="animate-spin" />
                ) : (
                  <UploadCloud size={12} strokeWidth={2.5} />
                )}
                Commit &amp; Push
              </button>
            </div>
            <p className="mt-2 text-xs text-gray-400">
              Pushes use your own SSH keys or git credential helper — WPHerd stores no
              credentials.
            </p>
            {busy && deployLines.length > 0 && (
              <ProgressLog messages={deployLines} className="mt-3" />
            )}
          </div>
        </>
      )}

      {error && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
