import { useState, useEffect } from 'react';
import {
  FolderOpen,
  FileArchive,
  CheckCircle,
  AlertCircle,
  AlertTriangle,
  Loader,
  ChevronRight,
  Globe,
} from 'lucide-react';
import { ProgressLog, StepIndicator, Tooltip } from './ui';

const STEPS = ['Archive', 'Destination', 'Importing'];

const KIND_LABELS = {
  wpherd: 'WPHerd export',
  wpress: 'All-in-One WP Migration',
  generic: 'Generic zip',
};

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export default function ImportSiteModal({ onClose, onSiteImported, phpVersions }) {
  const [step, setStep] = useState(0);
  const [archivePath, setArchivePath] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [info, setInfo] = useState(null); // { kind, manifest, originUrl, suggestedName, warning }
  const [formData, setFormData] = useState({
    name: '',
    domain: '',
    path: '',
    phpVersion: phpVersions?.[0]?.version || '8.2',
    dbName: '',
  });
  const [error, setError] = useState('');
  const [progressMessages, setProgressMessages] = useState([]);
  const [done, setDone] = useState(false);
  const [resultSite, setResultSite] = useState(null);

  useEffect(() => {
    window.electronAPI.on('site-import-progress', ({ message }) => {
      setProgressMessages((prev) => [...prev, message]);
    });
    return () => window.electronAPI.off('site-import-progress');
  }, []);

  async function handlePickArchive() {
    setError('');
    const selected = await window.electronAPI.selectImportFile();
    if (!selected) return;
    setArchivePath(selected);
    setInspecting(true);
    setInfo(null);
    const result = await window.electronAPI.inspectImportArchive(selected);
    setInspecting(false);
    if (!result.success) {
      setError(result.error || 'Could not read this archive.');
      setArchivePath('');
      return;
    }
    setInfo(result);
    // Prefill the destination from the manifest / filename.
    const name = result.manifest?.name || result.suggestedName || 'imported-site';
    const slug = slugify(name);
    const settings = await window.electronAPI.getSettings();
    setFormData((prev) => ({
      ...prev,
      name,
      domain: `${slug}.test`,
      dbName: `${slug.replace(/-/g, '_')}_db`,
      path: `${settings.sitesDir}/${slug}`,
      phpVersion:
        result.manifest?.phpVersion &&
        phpVersions?.some((v) => v.version === result.manifest.phpVersion)
          ? result.manifest.phpVersion
          : prev.phpVersion,
    }));
  }

  function updateName(value) {
    const slug = slugify(value);
    setFormData((prev) => {
      // Re-derive dependent fields only if the user hasn't detached them —
      // simplest faithful mirror of AddSiteModal's behavior: always re-derive.
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

  async function handleNext() {
    setError('');
    if (step === 0) {
      if (!archivePath) {
        setError('Choose an archive to import.');
        return;
      }
      setStep(1);
    } else if (step === 1) {
      if (!formData.name.trim()) {
        setError('Site name is required');
        return;
      }
      if (!formData.path.trim()) {
        setError('Site directory is required');
        return;
      }
      await handleImport();
    }
  }

  async function handleImport() {
    setStep(2);
    setProgressMessages(['Starting import...']);

    const result = await window.electronAPI.importSite({
      archivePath,
      ...formData,
    });

    if (result.success) {
      setProgressMessages((prev) => [...prev, 'Done! Site is ready.']);
      setDone(true);
      setResultSite(result.site);
      onSiteImported(result.site);
    } else {
      setError(result.error || 'Failed to import site');
      setStep(1);
    }
  }

  return (
    <div
      className="modal-overlay animate-fade-in"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="sheet w-[540px] max-h-[90vh] overflow-hidden animate-slide-in">
        <div className="px-6 pt-6">
          <h2 className="text-[15px] font-bold text-gray-900">Import Site</h2>
          <p className="text-[13px] text-gray-500 mt-0.5">
            Restore a site from a WPHerd export, a .wpress file, or a generic zip
          </p>
        </div>

        <div className={`px-6 pt-4 ${step === 2 ? 'pb-6' : ''}`}>
          {step < 2 && <StepIndicator current={step} steps={STEPS.slice(0, 2)} />}

          {/* Step 0: Choose archive */}
          {step === 0 && (
            <div className="sheet-well space-y-4 animate-fade-in">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1.5">
                  Site Archive
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    readOnly
                    className="form-input flex-1 font-mono text-xs"
                    value={archivePath}
                    placeholder="Choose a .zip or .wpress file…"
                  />
                  <Tooltip label="Choose archive">
                    <button
                      onClick={handlePickArchive}
                      aria-label="Choose archive"
                      className="btn-secondary !px-0 w-8 flex-shrink-0"
                    >
                      <FolderOpen size={14} />
                    </button>
                  </Tooltip>
                </div>
              </div>

              {inspecting && (
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  <Loader size={13} className="animate-spin" />
                  Inspecting archive…
                </div>
              )}

              {info && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300 rounded-full text-xs font-medium">
                      <FileArchive size={10} />
                      {KIND_LABELS[info.kind] || info.kind}
                    </span>
                    {info.manifest?.wpVersion &&
                      info.manifest.wpVersion !== 'unknown' && (
                        <span className="inline-flex items-center px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full text-xs font-medium">
                          WP {info.manifest.wpVersion}
                        </span>
                      )}
                    {info.manifest?.phpVersion && (
                      <span className="inline-flex items-center px-2 py-0.5 bg-purple-50 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300 rounded-full text-xs font-medium">
                        PHP {info.manifest.phpVersion}
                      </span>
                    )}
                  </div>
                  {info.originUrl && (
                    <p className="flex items-center gap-1.5 text-xs text-gray-500">
                      <Globe size={11} className="flex-shrink-0" />
                      Origin URL:{' '}
                      <span className="font-mono text-gray-700">{info.originUrl}</span>
                    </p>
                  )}
                  {info.warning && (
                    <div className="flex items-start gap-2 bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400 rounded-xl px-3 py-2.5 text-xs">
                      <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
                      <span>{info.warning}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Step 1: Destination */}
          {step === 1 && (
            <div className="sheet-well space-y-4 animate-fade-in">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1.5">
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
                  <label className="block text-xs font-medium text-gray-700 mb-1.5">
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
                  <label className="block text-xs font-medium text-gray-700 mb-1.5">
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
                <label className="block text-xs font-medium text-gray-700 mb-1.5">
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
                <label className="block text-xs font-medium text-gray-700 mb-1.5">
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
              {info?.originUrl && (
                <div className="bg-blue-50 dark:bg-blue-500/10 rounded-xl px-4 py-3 text-xs text-blue-700 dark:text-blue-300">
                  URLs in the database will be rewritten from{' '}
                  <span className="font-semibold font-mono">{info.originUrl}</span> to{' '}
                  <span className="font-semibold font-mono">
                    http://{formData.domain}
                  </span>
                  .
                </div>
              )}
            </div>
          )}

          {/* Step 2: Importing */}
          {step === 2 && (
            <div className="sheet-well animate-fade-in">
              {done ? (
                <div className="text-center py-4">
                  <div className="w-14 h-14 rounded-full bg-green-100 dark:bg-green-500/15 flex items-center justify-center mx-auto mb-3">
                    <CheckCircle size={28} className="text-wp-green" />
                  </div>
                  <h3 className="text-base font-bold text-gray-900">Site Imported!</h3>
                  <p className="text-sm text-gray-500 mt-1 mb-4">
                    Your site is ready at{' '}
                    <button
                      onClick={() =>
                        window.electronAPI.openSiteInBrowser(
                          resultSite?.url || `http://${formData.domain}`
                        )
                      }
                      className="text-wp-blue hover:underline font-medium"
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
                      className="animate-spin text-wp-blue flex-shrink-0"
                    />
                    <p className="text-sm font-medium text-gray-700">Importing site…</p>
                  </div>
                  <ProgressLog messages={progressMessages} className="mt-4" />
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mt-4 flex items-start gap-2 bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400 rounded-xl px-4 py-3 text-sm">
              <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        {step < 2 && (
          <div className="flex justify-end gap-2 px-6 pt-4 pb-6">
            <button
              onClick={() => (step === 0 ? onClose() : setStep((s) => s - 1))}
              className="btn-secondary"
            >
              {step === 0 ? 'Cancel' : 'Back'}
            </button>
            <button
              onClick={handleNext}
              disabled={step === 0 && (!archivePath || inspecting)}
              className="btn-primary"
            >
              {step === 1 ? 'Import Site' : 'Continue'}
              {step === 0 && <ChevronRight size={13} strokeWidth={2.5} />}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
