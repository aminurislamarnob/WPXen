import { useState, useEffect } from 'react';
import {
  X,
  FolderOpen,
  CheckCircle,
  AlertCircle,
  Loader,
  ChevronRight,
} from 'lucide-react';

const STEPS = ['Details', 'Directory', 'WordPress', 'Creating'];

function StepIndicator({ current, steps }) {
  return (
    <div className="flex items-center gap-1 mb-6">
      {steps.map((step, i) => (
        <div key={step} className="flex items-center">
          <div
            className={`flex items-center justify-center w-6 h-6 rounded-full text-xs font-semibold transition-all ${
              i < current
                ? 'bg-wp-green text-white'
                : i === current
                  ? 'bg-wp-blue text-white'
                  : 'bg-gray-200 text-gray-400'
            }`}
          >
            {i < current ? '✓' : i + 1}
          </div>
          {i < steps.length - 1 && (
            <div
              className={`w-8 h-0.5 mx-1 ${i < current ? 'bg-wp-green' : 'bg-gray-200'}`}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function ProgressLog({ messages }) {
  return (
    <div className="mt-4 bg-gray-900 rounded-lg p-4 h-40 overflow-y-auto font-mono text-xs">
      {messages.map((msg, i) => (
        <div
          key={i}
          className={`flex items-start gap-2 ${i === messages.length - 1 ? 'text-white' : 'text-gray-400'}`}
        >
          {i === messages.length - 1 ? (
            <Loader
              size={11}
              className="animate-spin mt-0.5 flex-shrink-0 text-wp-blue-light"
            />
          ) : (
            <CheckCircle size={11} className="mt-0.5 flex-shrink-0 text-wp-green" />
          )}
          <span>{msg}</span>
        </div>
      ))}
    </div>
  );
}

export default function AddSiteModal({ onClose, onSiteAdded, phpVersions }) {
  const [step, setStep] = useState(0);
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
      setStep(2);
    } else if (step === 2) {
      await handleCreate();
    }
  }

  async function handleCreate() {
    setStep(3);
    setCreating(true);
    setProgressMessages(['Starting WordPress installation...']);

    const result = await window.electronAPI.addSite(formData);

    setCreating(false);

    if (result.success) {
      setProgressMessages((prev) => [...prev, 'Done! Site is ready.']);
      setDone(true);
      onSiteAdded(result.site);
    } else {
      setError(result.error || 'Failed to create site');
      setStep(2);
    }
  }

  return (
    <div
      className="modal-overlay animate-fade-in"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white rounded-2xl shadow-window w-[520px] max-h-[90vh] overflow-hidden animate-slide-in">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-bold text-gray-900">Add WordPress Site</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              Set up a new local WordPress site
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-6">
          {step < 3 && <StepIndicator current={step} steps={STEPS.slice(0, 3)} />}

          {/* Step 0: Site details */}
          {step === 0 && (
            <div className="space-y-4 animate-fade-in">
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
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1.5">
                  Site Title
                </label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="My WordPress Site"
                  value={formData.title}
                  onChange={(e) => setFormData((p) => ({ ...p, title: e.target.value }))}
                />
              </div>
            </div>
          )}

          {/* Step 1: Directory */}
          {step === 1 && (
            <div className="space-y-4 animate-fade-in">
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
                  <button
                    onClick={handleSelectFolder}
                    className="btn-secondary px-3 flex-shrink-0"
                  >
                    <FolderOpen size={15} />
                  </button>
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

          {/* Step 2: WordPress/Admin settings */}
          {step === 2 && (
            <div className="space-y-4 animate-fade-in">
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
              <div className="bg-blue-50 rounded-lg px-4 py-3 text-xs text-blue-700">
                WordPress will be installed at{' '}
                <span className="font-semibold font-mono">{formData.domain}</span> with
                the credentials above.
              </div>
            </div>
          )}

          {/* Step 3: Creating */}
          {step === 3 && (
            <div className="animate-fade-in">
              {done ? (
                <div className="text-center py-4">
                  <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-3">
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
                      className="btn-primary text-sm"
                    >
                      Open Site
                    </button>
                    <button
                      onClick={() =>
                        window.electronAPI.openWpAdmin(`http://${formData.domain}`)
                      }
                      className="btn-secondary text-sm"
                    >
                      wp-admin
                    </button>
                    <button onClick={onClose} className="btn-ghost text-sm">
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
                      Creating WordPress site…
                    </p>
                  </div>
                  <ProgressLog messages={progressMessages} />
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mt-4 flex items-start gap-2 bg-red-50 text-red-700 rounded-lg px-4 py-3 text-sm">
              <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        {step < 3 && (
          <div className="flex justify-between px-6 pb-5">
            <button
              onClick={() => (step === 0 ? onClose() : setStep((s) => s - 1))}
              className="btn-secondary text-sm"
            >
              {step === 0 ? 'Cancel' : 'Back'}
            </button>
            <button onClick={handleNext} className="btn-primary text-sm">
              {step === 2 ? 'Create Site' : 'Continue'}
              {step < 2 && <ChevronRight size={14} className="ml-1" />}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
