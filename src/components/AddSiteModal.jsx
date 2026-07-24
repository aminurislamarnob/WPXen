import { useState, useEffect } from 'react';
import { FolderOpen, CheckCircle, AlertCircle, Loader, ChevronRight } from 'lucide-react';
import { ProgressLog, StepIndicator, Tooltip } from './ui';

export default function AddSiteModal({
  onClose,
  onSiteAdded,
  phpVersions,
  blueprints = [],
}) {
  const [step, setStep] = useState(0);
  // Source: a blank WordPress install, or a saved blueprint's id.
  const [source, setSource] = useState('blank');
  const blueprint = source === 'blank' ? null : blueprints.find((b) => b.id === source);
  const isBlueprint = !!blueprint;
  // Blueprint sites carry their own users, so the admin-credentials step is
  // skipped: [Details, Directory, Creating] vs [Details, Directory, WordPress,
  // Creating].
  const formSteps = isBlueprint
    ? ['Details', 'Directory']
    : ['Details', 'Directory', 'WordPress'];
  const creatingStep = formSteps.length;

  const [formData, setFormData] = useState({
    name: '',
    domain: '',
    path: '',
    phpVersion: phpVersions?.[0]?.version || '8.2',
    dbName: '',
    adminUser: 'admin',
    adminPassword: 'admin123',
    adminEmail: '',
    title: '',
  });
  const [error, setError] = useState('');
  const [, setCreating] = useState(false);
  const [progressMessages, setProgressMessages] = useState([]);
  const [done, setDone] = useState(false);

  function chooseSource(next) {
    setSource(next);
    setError('');
    // Match the blueprint's PHP version when one is available.
    const bp = next === 'blank' ? null : blueprints.find((b) => b.id === next);
    if (bp?.phpVersion && phpVersions?.some((v) => v.version === bp.phpVersion)) {
      setFormData((prev) => ({ ...prev, phpVersion: bp.phpVersion }));
    }
  }

  useEffect(() => {
    // Listen for progress events from main process
    window.electronAPI.on('site-create-progress', ({ message }) => {
      setProgressMessages((prev) => [...prev, message]);
    });
    return () => window.electronAPI.off('site-create-progress');
  }, []);

  function updateField(field, value) {
    setFormData((prev) => {
      const next = { ...prev, [field]: value };
      if (field === 'name') {
        const slug = value
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '');
        next.domain = `${slug}.test`;
        next.dbName = slug.replace(/-/g, '_') + '_db';
        next.title = value;
        next.adminEmail = `admin@${slug}.test`;
        // Will be updated with actual path on step change
      }
      return next;
    });
  }

  async function loadDefaultPath() {
    if (!formData.path && formData.domain) {
      // sitesDir is always provided by the main process (it falls back to
      // ~/Sites there); the renderer has no access to process.env.
      const settings = await window.electronAPI.getSettings();
      const sitesDir = settings.sitesDir;
      const slug = formData.domain.replace('.test', '');
      setFormData((prev) => ({
        ...prev,
        path: `${sitesDir}/${slug}`,
      }));
    }
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
      if (!formData.name.trim()) {
        setError('Site name is required');
        return;
      }
      await loadDefaultPath();
      setStep(1);
    } else if (step === 1) {
      if (!formData.path.trim()) {
        setError('Site directory is required');
        return;
      }
      // Blueprint installs have no admin step — go straight to creating.
      if (isBlueprint) await handleCreate();
      else setStep(2);
    } else if (step === 2) {
      await handleCreate();
    }
  }

  async function handleCreate() {
    setStep(creatingStep);
    setCreating(true);
    setProgressMessages([
      isBlueprint
        ? 'Creating site from blueprint…'
        : 'Starting WordPress installation...',
    ]);

    const result = isBlueprint
      ? await window.electronAPI.createSiteFromBlueprint({
          blueprintId: blueprint.id,
          name: formData.name,
          domain: formData.domain,
          path: formData.path,
          phpVersion: formData.phpVersion,
          dbName: formData.dbName,
        })
      : await window.electronAPI.addSite(formData);

    setCreating(false);

    if (result.success) {
      setProgressMessages((prev) => [...prev, 'Done! Site is ready.']);
      setDone(true);
      onSiteAdded(result.site);
    } else {
      setError(result.error || 'Failed to create site');
      setStep(isBlueprint ? 1 : 2);
    }
  }

  return (
    <div
      className="modal-overlay animate-fade-in"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="sheet w-[540px] max-h-[90vh] overflow-hidden animate-slide-in">
        {/* Header — title + description block, no close chip (macOS sheet) */}
        <div className="px-6 pt-6">
          <h2 className="text-[15px] font-bold text-gray-900">Add WordPress Site</h2>
          <p className="text-[13px] text-gray-500 mt-0.5">
            Set up a new local WordPress site
          </p>
        </div>

        <div className={`px-6 pt-4 ${step === creatingStep ? 'pb-6' : ''}`}>
          {step < creatingStep && <StepIndicator current={step} steps={formSteps} />}

          {/* Step 0: Site details */}
          {step === 0 && (
            <div className="sheet-well space-y-4 animate-fade-in">
              {blueprints.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1.5">
                    Start From
                  </label>
                  <div className="flex gap-1 p-0.5 bg-gray-100 dark:bg-white/5 rounded-lg">
                    <button
                      onClick={() => chooseSource('blank')}
                      className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-colors ${
                        source === 'blank'
                          ? 'bg-surface shadow-sm text-gray-900'
                          : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      Blank WordPress
                    </button>
                    <button
                      onClick={() =>
                        chooseSource(isBlueprint ? source : blueprints[0].id)
                      }
                      className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-colors ${
                        isBlueprint
                          ? 'bg-surface shadow-sm text-gray-900'
                          : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      From Blueprint
                    </button>
                  </div>
                  {isBlueprint && (
                    <select
                      className="form-input mt-2"
                      value={source}
                      onChange={(e) => chooseSource(e.target.value)}
                    >
                      {blueprints.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1.5">
                  Site Name
                </label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="My WordPress Site"
                  value={formData.name}
                  onChange={(e) => updateField('name', e.target.value)}
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1.5">
                  Local Domain
                </label>
                <div className="relative">
                  <input
                    type="text"
                    className="form-input"
                    value={formData.domain}
                    onChange={(e) =>
                      setFormData((p) => ({ ...p, domain: e.target.value }))
                    }
                    placeholder="mysite.test"
                  />
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  Accessible at{' '}
                  <span className="font-mono text-wp-blue">
                    {formData.domain || 'mysite.test'}
                  </span>
                </p>
              </div>
              {!isBlueprint && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1.5">
                    Site Title
                  </label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="My WordPress Site"
                    value={formData.title}
                    onChange={(e) =>
                      setFormData((p) => ({ ...p, title: e.target.value }))
                    }
                  />
                </div>
              )}
              {isBlueprint && (
                <div className="bg-blue-50 dark:bg-blue-500/10 rounded-xl px-4 py-3 text-xs text-blue-700 dark:text-blue-300">
                  This site will be created from the{' '}
                  <span className="font-semibold">{blueprint.name}</span> blueprint — its
                  files, database, and users are restored as-is.
                </div>
              )}
            </div>
          )}

          {/* Step 1: Directory */}
          {step === 1 && (
            <div className="sheet-well space-y-4 animate-fade-in">
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
                    placeholder={`~/Sites/${formData.domain.replace('.test', '')}`}
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
                <p className="text-xs text-gray-400 mt-1">
                  WordPress files will be installed here
                </p>
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
            </div>
          )}

          {/* Step 2: WordPress/Admin settings (blank installs only) */}
          {step === 2 && !isBlueprint && (
            <div className="sheet-well space-y-4 animate-fade-in">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1.5">
                  Database Name
                </label>
                <input
                  type="text"
                  className="form-input font-mono text-xs"
                  value={formData.dbName}
                  onChange={(e) => setFormData((p) => ({ ...p, dbName: e.target.value }))}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1.5">
                    Admin Username
                  </label>
                  <input
                    type="text"
                    className="form-input"
                    value={formData.adminUser}
                    onChange={(e) =>
                      setFormData((p) => ({ ...p, adminUser: e.target.value }))
                    }
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1.5">
                    Admin Password
                  </label>
                  <input
                    type="text"
                    className="form-input"
                    value={formData.adminPassword}
                    onChange={(e) =>
                      setFormData((p) => ({ ...p, adminPassword: e.target.value }))
                    }
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1.5">
                  Admin Email
                </label>
                <input
                  type="email"
                  className="form-input"
                  value={formData.adminEmail}
                  onChange={(e) =>
                    setFormData((p) => ({ ...p, adminEmail: e.target.value }))
                  }
                />
              </div>
              <div className="bg-blue-50 dark:bg-blue-500/10 rounded-xl px-4 py-3 text-xs text-blue-700 dark:text-blue-300">
                WordPress will be installed at{' '}
                <span className="font-semibold font-mono">{formData.domain}</span> with
                the credentials above.
              </div>
            </div>
          )}

          {/* Final step: Creating */}
          {step === creatingStep && (
            <div className="sheet-well animate-fade-in">
              {done ? (
                <div className="text-center py-4">
                  <div className="w-14 h-14 rounded-full bg-green-100 dark:bg-green-500/15 flex items-center justify-center mx-auto mb-3">
                    <CheckCircle size={28} className="text-wp-green" />
                  </div>
                  <h3 className="text-base font-bold text-gray-900">Site Created!</h3>
                  <p className="text-sm text-gray-500 mt-1 mb-4">
                    Your WordPress site is ready at{' '}
                    <button
                      onClick={() =>
                        window.electronAPI.openSiteInBrowser(`http://${formData.domain}`)
                      }
                      className="text-wp-blue hover:underline font-medium"
                    >
                      {formData.domain}
                    </button>
                  </p>
                  <div className="flex gap-2 justify-center">
                    <button
                      onClick={() =>
                        window.electronAPI.openSiteInBrowser(`http://${formData.domain}`)
                      }
                      className="btn-primary"
                    >
                      Open Site
                    </button>
                    <button
                      onClick={() =>
                        window.electronAPI.openSiteInBrowser(
                          `http://${formData.domain}/wp-admin`
                        )
                      }
                      className="btn-secondary"
                    >
                      wp-admin
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
                    <p className="text-sm font-medium text-gray-700">
                      {isBlueprint
                        ? 'Creating site from blueprint…'
                        : 'Creating WordPress site…'}
                    </p>
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

        {/* Footer — buttons bottom-right like macOS sheets */}
        {step < creatingStep && (
          <div className="flex justify-end gap-2 px-6 pt-4 pb-6">
            <button
              onClick={() => (step === 0 ? onClose() : setStep((s) => s - 1))}
              className="btn-secondary"
            >
              {step === 0 ? 'Cancel' : 'Back'}
            </button>
            <button onClick={handleNext} className="btn-primary">
              {step === creatingStep - 1 ? 'Create Site' : 'Continue'}
              {step < creatingStep - 1 && <ChevronRight size={13} strokeWidth={2.5} />}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
