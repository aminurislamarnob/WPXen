import { useState, useEffect } from 'react';
import { AlertCircle, FolderOpen, Globe, Loader } from 'lucide-react';

// Add project → Clone from URL…: a Git URL and a parent folder; the repo is
// cloned into <parent>/<repo-name> and added as a folder project. The last
// parent used is remembered per viewer.
const PARENT_KEY = 'wpxen.cloneParent';

function readParent() {
  try {
    return localStorage.getItem(PARENT_KEY) || '';
  } catch {
    return '';
  }
}

function writeParent(dir) {
  try {
    localStorage.setItem(PARENT_KEY, dir);
  } catch {
    // Not remembering it is fine.
  }
}

// Mirrors repoNameFromUrl in electron/services/gitClone.cjs — only used to
// preview where the clone will land.
function repoName(url) {
  const last =
    url
      .trim()
      .replace(/[/\\]+$/, '')
      .split(/[/\\:]/)
      .pop() || '';
  return last.replace(/\.git$/i, '');
}

export default function CloneRepoModal({ onClose, onCloned }) {
  const [url, setUrl] = useState('');
  const [parent, setParent] = useState(readParent);
  const [cloning, setCloning] = useState(false);
  const [progress, setProgress] = useState(null); // { phase, percent }
  const [error, setError] = useState('');

  useEffect(() => {
    if (parent) return;
    window.electronAPI.getCloneDefaultParent().then((dir) => {
      setParent((p) => p || dir || '');
    });
    // Only the initial default; the user's edits win after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => window.electronAPI.on('agent-clone-progress', setProgress), []);

  const canClone = !!url.trim() && !!parent.trim() && !cloning;
  const name = repoName(url);

  const pickParent = async () => {
    const dir = await window.electronAPI.selectFolder(parent || undefined);
    if (dir) setParent(dir);
  };

  const clone = async () => {
    if (!canClone) return;
    setCloning(true);
    setProgress(null);
    setError('');
    const res = await window.electronAPI.cloneAgentFolder(url.trim(), parent.trim());
    setCloning(false);
    if (res?.ok) {
      writeParent(parent.trim());
      onCloned(res.id);
    } else {
      setError(res?.error || 'Clone failed.');
    }
  };

  const cancel = () => {
    if (cloning) window.electronAPI.abortAgentClone();
    else onClose();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      clone();
    }
  };

  return (
    <div
      className="modal-overlay animate-fade-in"
      onClick={(e) => e.target === e.currentTarget && !cloning && onClose()}
    >
      <div className="sheet w-[520px] max-h-[90vh] overflow-hidden animate-slide-in">
        <div className="px-6 pt-6">
          <h2 className="text-[15px] font-bold text-foreground">Clone from URL</h2>
          <p className="text-[13px] text-muted-foreground mt-0.5">
            Clone a remote Git repository and add it as a project.
          </p>
        </div>

        <div className="px-6 pt-4 pb-6">
          <div className="sheet-well space-y-4">
            <div>
              <label className="block text-xs font-medium text-foreground mb-1.5">
                Git URL
              </label>
              <div className="relative">
                <Globe
                  size={14}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <input
                  type="text"
                  className="form-input pl-9"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="https://github.com/user/repo.git"
                  spellCheck={false}
                  disabled={cloning}
                  autoFocus
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-foreground mb-1.5">
                Parent folder
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  className="form-input flex-1"
                  value={parent}
                  onChange={(e) => setParent(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="/path/to/destination"
                  spellCheck={false}
                  disabled={cloning}
                />
                <button
                  onClick={pickParent}
                  className="btn-secondary"
                  disabled={cloning}
                  title="Choose folder"
                  aria-label="Choose folder"
                >
                  <FolderOpen size={14} />
                </button>
              </div>
              {name && parent.trim() && (
                <p className="text-xs text-muted-foreground mt-1.5 truncate">
                  Clones into{' '}
                  <span className="font-mono">
                    {parent.trim().replace(/\/+$/, '')}/{name}
                  </span>
                </p>
              )}
            </div>

            {cloning && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Loader size={12} className="animate-spin text-highlight" />
                    {progress?.phase || 'Cloning…'}
                  </span>
                  {progress && <span>{progress.percent}%</span>}
                </div>
                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-highlight transition-[width] duration-300 ease-out"
                    style={{ width: `${progress?.percent ?? 0}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="mt-4 flex items-start gap-2 bg-destructive/10 text-destructive rounded-xl px-4 py-3 text-sm">
              <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
              <span className="break-words min-w-0">{error}</span>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-6 pb-6">
          <button onClick={cancel} className="btn-secondary">
            Cancel
          </button>
          <button onClick={clone} className="btn-primary" disabled={!canClone}>
            {cloning ? 'Cloning…' : 'Clone'}
          </button>
        </div>
      </div>
    </div>
  );
}
