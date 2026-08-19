import { useState, useEffect } from 'react';
import {
  FolderOpen,
  CheckCircle,
  AlertCircle,
  Loader,
  Copy as CopyIcon,
} from 'lucide-react';
import { ProgressLog, Tooltip } from './ui';

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export default function CloneSiteModal({ source, phpVersions, onClose, onCloned }) {
  const initialSlug = slugify(`${source.name} copy`);
  const [formData, setFormData] = useState({
    name: `${source.name} copy`,
    domain: `${initialSlug}.test`,
    path: '',
    phpVersion: source.phpVersion || phpVersions?.[0]?.version || '8.2',
    dbName: `${initialSlug.replace(/-/g, '_')}_db`,
  });
  const [error, setError] = useState('');
  const [phase, setPhase] = useState('form'); // form | cloning | done
  const [progressMessages, setProgressMessages] = useState([]);
  const [resultSite, setResultSite] = useState(null);

  useEffect(() => {
    // Seed the path from the current sites directory, next to the source.
    window.electronAPI.getSettings().then((settings) => {
      setFormData((prev) => ({
        ...prev,
        path: `${settings.sitesDir}/${slugify(prev.name)}`,
      }));
    });
  }, []);

  useEffect(() => {
    window.electronAPI.on('site-clone-progress', ({ message }) => {
      setProgressMessages((prev) => [...prev, message]);
    });
    return () => window.electronAPI.off('site-clone-progress');
  }, []);

  function updateName(value) {
    const slug = slugify(value);
    setFormData((prev) => {
      const oldSlug = slugify(prev.name);
      return {
        ...prev,
        name: value,
        domain: `${slug}.test`,
        dbName: `${slug.replace(/-/g, '_')}_db`,
        path:
          prev.path && oldSlug && prev.path.endsWith(`/${oldSlug}`)
            ? prev.path.slice(0, -oldSlug.length) + slug
            : prev.path,
      };
    });
  }

  async function handleSelectFolder() {
    const selected = await window.electronAPI.selectFolder();
    if (selected) {
      const slug = formData.domain.replace('.test', '');
      setFormData((prev) => ({ ...prev, path: `${selected}/${slug}` }));
    }
  }

  async function handleClone() {
    setError('');
    if (!formData.name.trim()) return setError('Site name is required');
    if (!formData.path.trim()) return setError('Site directory is required');

    setPhase('cloning');
    setProgressMessages(['Starting clone…']);
    const result = await window.electronAPI.cloneSite(source.id, formData);
    if (result.success) {
      setProgressMessages((prev) => [...prev, 'Done! Clone is ready.']);
      setResultSite(result.site);
      setPhase('done');
      onCloned(result.site);
    } else {
      setError(result.error || 'Failed to clone site');
      setPhase('form');
    }
  }

  return (
    <div
      className="modal-overlay animate-fade-in"
      onClick={(e) => e.target === e.currentTarget && phase !== 'cloning' && onClose()}
    >
      <div className="sheet w-[540px] max-h-[90vh] overflow-hidden animate-slide-in">
        <div className="px-6 pt-6">
          <h2 className="text-[15px] font-bold text-foreground">Clone Site</h2>
          <p className="text-[13px] text-muted-foreground mt-0.5">
            Duplicate <span className="font-semibold">{source.name}</span> into a new
            local site
          </p>
        </div>

        <div className="px-6 pt-4 pb-6">
          {phase === 'form' && (
            <div className="sheet-well space-y-4 animate-fade-in">
              <div>
                <label className="block text-xs font-medium text-foreground mb-1.5">
                  Site Name
                </label>
                <input
                  type="text"
                  className="form-input"
                  value={formData.name}
                  onChange={(e) => updateName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1.5">
                    Local Domain
                  </label>
                  <input
                    type="text"
                    className="form-input"
                    value={formData.domain}
                    onChange={(e) =>
                      setFormData((p) => ({ ...p, domain: e.target.value }))
                    }
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1.5">
                    Database Name
                  </label>
                  <input
                    type="text"
                    className="form-input font-mono text-xs"
                    value={formData.dbName}
                    onChange={(e) =>
                      setFormData((p) => ({ ...p, dbName: e.target.value }))
                    }
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1.5">
                  Site Directory
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    className="form-input flex-1"
                    value={formData.path}
                    onChange={(e) => setFormData((p) => ({ ...p, path: e.target.value }))}
                  />
                  <Tooltip label="Choose folder">
                    <button
                      onClick={handleSelectFolder}
                      aria-label="Choose folder"
                      className="btn-secondary !px-0 w-8 flex-shrink-0"
                    >
                      <FolderOpen size={14} />
                    </button>
                  </Tooltip>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1.5">
                  PHP Version
                </label>
                <select
                  className="form-input"
                  value={formData.phpVersion}
                  onChange={(e) =>
                    setFormData((p) => ({ ...p, phpVersion: e.target.value }))
                  }
                >
                  {phpVersions && phpVersions.length > 0 ? (
                    phpVersions.map((v) => (
                      <option key={v.version} value={v.version}>
                        PHP {v.version} {v.active ? '(active)' : ''}
                      </option>
                    ))
                  ) : (
                    <option value="8.2">PHP 8.2 (default)</option>
                  )}
                </select>
              </div>
              {source.https && (
                <div className="bg-highlight/10 rounded-xl px-4 py-3 text-xs text-highlight">
                  A new trusted HTTPS certificate will be issued for{' '}
                  <span className="font-semibold font-mono">{formData.domain}</span>.
                </div>
              )}
            </div>
          )}

          {(phase === 'cloning' || phase === 'done') && (
            <div className="sheet-well animate-fade-in">
              {phase === 'done' ? (
                <div className="text-center py-4">
                  <div className="w-14 h-14 rounded-full bg-status-running/10 flex items-center justify-center mx-auto mb-3">
                    <CheckCircle size={28} className="text-status-running" />
                  </div>
                  <h3 className="text-base font-bold text-foreground">Site Cloned!</h3>
                  <p className="text-sm text-muted-foreground mt-1 mb-4">
                    Your clone is ready at{' '}
                    <button
                      onClick={() =>
                        window.electronAPI.openSiteInBrowser(
                          resultSite?.url || `http://${formData.domain}`
                        )
                      }
                      className="text-highlight hover:underline font-medium"
                    >
                      {formData.domain}
                    </button>
                  </p>
                  <div className="flex gap-2 justify-center">
                    <button
                      onClick={() =>
                        window.electronAPI.openSiteInBrowser(
                          resultSite?.url || `http://${formData.domain}`
                        )
                      }
                      className="btn-primary"
                    >
                      Open Site
                    </button>
                    <button onClick={onClose} className="btn-ghost">
                      Done
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="flex items-center gap-3 mb-2">
                    <Loader
                      size={18}
                      className="animate-spin text-highlight flex-shrink-0"
                    />
                    <p className="text-sm font-medium text-foreground">Cloning site…</p>
                  </div>
                  <ProgressLog messages={progressMessages} className="mt-4" />
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="mt-4 flex items-start gap-2 bg-destructive/10 text-destructive rounded-xl px-4 py-3 text-sm">
              <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {phase === 'form' && (
          <div className="flex justify-end gap-2 px-6 pb-6">
            <button onClick={onClose} className="btn-secondary">
              Cancel
            </button>
            <button onClick={handleClone} className="btn-primary">
              <CopyIcon size={12} strokeWidth={2.5} />
              Clone Site
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
