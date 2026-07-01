import { useState, useEffect } from 'react';
import { CheckCircle, Loader, Code2, Star, Info } from 'lucide-react';
import { StatusBadge } from './StatusBadge';

function VersionCard({ version, onSwitch, switching }) {
  const isLoading = switching === version.version;

  return (
    <div
      className={`bg-white rounded-xl border shadow-card p-5 transition-all duration-200 ${
        version.active
          ? 'border-wp-blue ring-2 ring-wp-blue/20'
          : 'border-surface-border hover:shadow-card-hover'
      }`}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div
            className={`w-11 h-11 rounded-xl flex items-center justify-center font-mono text-sm font-bold ${
              version.active ? 'bg-wp-blue text-white' : 'bg-purple-50 text-purple-700'
            }`}
          >
            {version.version}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-900">
                PHP {version.version}
              </h3>
              {version.active && (
                <span className="flex items-center gap-1 px-2 py-0.5 bg-wp-blue/10 text-wp-blue rounded-full text-xs font-medium">
                  <Star size={10} fill="currentColor" />
                  Active
                </span>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              Full version: {version.fullVersion}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 text-xs">
            <StatusBadge running={version.running} />
            <span className={version.running ? 'text-wp-green' : 'text-gray-400'}>
              FPM {version.running ? 'on' : 'off'}
            </span>
          </div>
        </div>
      </div>

      {/* Socket path */}
      {version.socketPath && (
        <div className="mt-3 px-3 py-2 bg-gray-50 rounded-lg">
          <p
            className="text-xs text-gray-400 font-mono truncate"
            title={version.socketPath}
          >
            {version.socketPath}
          </p>
        </div>
      )}

      {/* Actions */}
      {!version.active && (
        <div className="mt-4">
          <button
            onClick={() => onSwitch(version.version)}
            disabled={isLoading}
            className="btn-secondary w-full text-xs justify-center"
          >
            {isLoading ? (
              <>
                <Loader size={12} className="animate-spin mr-1.5" />
                Switching…
              </>
            ) : (
              'Set as Active'
            )}
          </button>
        </div>
      )}
    </div>
  );
}

export default function PHPVersions() {
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(null);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    loadVersions();
  }, []);

  async function loadVersions() {
    setLoading(true);
    try {
      const v = await window.electronAPI.getPhpVersions();
      setVersions(v);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSwitch(version) {
    setSwitching(version);
    setMessage(null);
    const result = await window.electronAPI.switchPhpVersion(version);
    if (result.success) {
      setMessage({
        type: 'success',
        text: `Switched to PHP ${version}. Restart PHP-FPM to apply.`,
      });
      await loadVersions();
    } else {
      setMessage({ type: 'error', text: result.error });
    }
    setSwitching(null);
  }

  return (
    <div className="p-6 max-w-3xl animate-fade-in">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold text-gray-900">PHP Versions</h1>
          <p className="text-sm text-gray-500 mt-0.5">Manage installed PHP versions</p>
        </div>
        <button onClick={loadVersions} className="btn-secondary text-sm">
          Refresh
        </button>
      </div>

      {message && (
        <div
          className={`flex items-center gap-2 px-4 py-3 rounded-xl mb-4 text-sm animate-fade-in ${
            message.type === 'error'
              ? 'bg-red-50 text-red-700'
              : 'bg-green-50 text-green-700'
          }`}
        >
          <CheckCircle size={15} />
          {message.text}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader size={22} className="animate-spin text-wp-blue" />
        </div>
      ) : versions.length === 0 ? (
        <div className="text-center py-16">
          <div className="w-14 h-14 rounded-xl bg-purple-50 flex items-center justify-center mx-auto mb-3">
            <Code2 size={24} className="text-purple-500" />
          </div>
          <h3 className="text-sm font-bold text-gray-700">No PHP versions found</h3>
          <p className="text-xs text-gray-400 mt-2 mb-4">
            Install PHP via Homebrew to get started
          </p>
          <code className="block bg-gray-900 text-green-400 px-4 py-2 rounded-lg text-xs font-mono">
            brew install php@8.2
          </code>
        </div>
      ) : (
        <div className="space-y-3">
          {versions.map((v) => (
            <VersionCard
              key={v.version}
              version={v}
              onSwitch={handleSwitch}
              switching={switching}
            />
          ))}
        </div>
      )}

      <div className="mt-5 flex items-start gap-3 bg-blue-50 rounded-xl px-4 py-3 text-sm text-blue-700">
        <Info size={15} className="flex-shrink-0 mt-0.5" />
        <div>
          <p className="font-medium">Install more PHP versions</p>
          <p className="text-xs text-blue-600 mt-0.5">
            <span className="font-mono bg-blue-100 px-1 rounded">
              brew install php@8.1 php@8.2 php@8.3
            </span>{' '}
            — then restart WPHerd.
          </p>
        </div>
      </div>
    </div>
  );
}
