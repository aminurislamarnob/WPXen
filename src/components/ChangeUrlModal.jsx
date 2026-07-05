import { useState, useEffect } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle, Loader, Globe } from 'lucide-react';
import { ProgressLog } from './ui';

export default function ChangeUrlModal({ site, onClose, onChanged }) {
  const [domain, setDomain] = useState(site.domain);
  const [error, setError] = useState('');
  const [phase, setPhase] = useState('form'); // form | working | done
  const [progressMessages, setProgressMessages] = useState([]);
  const [resultSite, setResultSite] = useState(null);

  useEffect(() => {
    window.electronAPI.on('site-changeurl-progress', ({ message }) => {
      setProgressMessages((prev) => [...prev, message]);
    });
    return () => window.electronAPI.off('site-changeurl-progress');
  }, []);

  async function handleSubmit() {
    setError('');
    const next = domain.trim();
    if (!next) return setError('Enter a new domain.');
    if (next === site.domain) return setError('That is already the site’s domain.');

    setPhase('working');
    setProgressMessages(['Starting…']);
    const result = await window.electronAPI.changeSiteUrl(site.id, next);
    if (result.success) {
      setProgressMessages((prev) => [...prev, 'Done!']);
      setResultSite(result.site);
      setPhase('done');
      onChanged(result.site);
    } else {
      setError(result.error || 'Failed to change the URL.');
      setPhase('form');
    }
  }

  return (
    <div
      className="modal-overlay animate-fade-in"
      onClick={(e) => e.target === e.currentTarget && phase !== 'working' && onClose()}
    >
      <div className="sheet w-[520px] max-h-[90vh] overflow-hidden animate-slide-in">
        <div className="px-6 pt-6">
          <h2 className="text-[15px] font-bold text-gray-900">Change Site URL</h2>
          <p className="text-[13px] text-gray-500 mt-0.5">
            Rename the local domain for <span className="font-semibold">{site.name}</span>
          </p>
        </div>

        <div className="px-6 pt-4 pb-6">
          {phase === 'form' && (
            <div className="sheet-well space-y-4 animate-fade-in">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1.5">
                  New Domain
                </label>
                <div className="relative">
                  <Globe
                    size={14}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
                  />
                  <input
                    type="text"
                    className="form-input pl-9"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    placeholder="mysite.test"
                    autoFocus
                  />
                </div>
                <p className="text-xs text-gray-500 mt-1.5">
                  Currently <span className="font-mono">{site.domain}</span>. Use a{' '}
                  <span className="font-mono">.test</span> domain so dnsmasq resolves it.
                </p>
              </div>

              <div className="flex items-start gap-2 bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400 rounded-xl px-3 py-2.5 text-xs">
                <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                <span>
                  This runs a database search-and-replace across all tables and rewrites
                  the site URL. Any active share tunnel will be stopped. Consider exporting
                  a backup first.
                </span>
              </div>
            </div>
          )}

          {(phase === 'working' || phase === 'done') && (
            <div className="sheet-well animate-fade-in">
              {phase === 'done' ? (
                <div className="text-center py-4">
                  <div className="w-14 h-14 rounded-full bg-green-100 dark:bg-green-500/15 flex items-center justify-center mx-auto mb-3">
                    <CheckCircle size={28} className="text-wp-green" />
                  </div>
                  <h3 className="text-base font-bold text-gray-900">URL Changed!</h3>
                  <p className="text-sm text-gray-500 mt-1 mb-4">
                    The site now lives at{' '}
                    <button
                      onClick={() =>
                        window.electronAPI.openSiteInBrowser(
                          resultSite?.url || `http://${domain}`
                        )
                      }
                      className="text-wp-blue hover:underline font-medium"
                    >
                      {domain}
                    </button>
                  </p>
                  <button onClick={onClose} className="btn-primary">
                    Done
                  </button>
                </div>
              ) : (
                <div>
                  <div className="flex items-center gap-3 mb-2">
                    <Loader
                      size={18}
                      className="animate-spin text-wp-blue flex-shrink-0"
                    />
                    <p className="text-sm font-medium text-gray-700">Changing URL…</p>
                  </div>
                  <ProgressLog messages={progressMessages} className="mt-4" />
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="mt-4 flex items-start gap-2 bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400 rounded-xl px-4 py-3 text-sm">
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
            <button onClick={handleSubmit} className="btn-primary">
              Change URL
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
