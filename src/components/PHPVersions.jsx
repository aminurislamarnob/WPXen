import { useState, useEffect, useRef } from 'react';
import {
  CheckCircle,
  Loader,
  Code2,
  Star,
  Download,
  ArrowUpCircle,
} from 'lucide-react';
import { StatusBadge } from './StatusBadge';

function VersionCard({ version, onSwitch, switching, onUpdate, updating, logLine }) {
  const isLoading = switching === version.version;
  const isUpdating = updating === version.version;

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
              {version.outdated && (
                <span className="flex items-center gap-1 px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full text-xs font-medium">
                  <ArrowUpCircle size={10} />
                  Update available
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
      {(!version.active || version.outdated) && (
        <div className="mt-4 flex gap-2">
          {!version.active && (
            <button
              onClick={() => onSwitch(version.version)}
              disabled={isLoading || isUpdating}
              className="btn-secondary flex-1 text-xs justify-center"
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
          )}
          {version.outdated && (
            <button
              onClick={() => onUpdate(version.version)}
              disabled={isLoading || isUpdating}
              className="btn-secondary flex-1 text-xs justify-center"
            >
              {isUpdating ? (
                <>
                  <Loader size={12} className="animate-spin mr-1.5" />
                  Updating…
                </>
              ) : (
                <>
                  <ArrowUpCircle size={12} className="mr-1.5" />
                  Update
                </>
              )}
            </button>
          )}
        </div>
      )}

      {isUpdating && (
        <div className="mt-3 px-3 py-2 bg-gray-900 rounded-lg">
          <p className="text-xs text-green-400 font-mono truncate" title={logLine}>
            {logLine || 'Starting…'}
          </p>
        </div>
      )}
    </div>
  );
}

function InstallRow({ version, onInstall, installing, logLine, disabled }) {
  const isInstalling = installing === version;

  return (
    <div className="bg-white rounded-xl border border-surface-border shadow-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-purple-50 text-purple-700 flex items-center justify-center font-mono text-xs font-bold">
            {version}
          </div>
          <div>
            <h4 className="text-sm font-semibold text-gray-900">PHP {version}</h4>
            <p className="text-xs text-gray-400 font-mono">php@{version}</p>
          </div>
        </div>
        <button
          onClick={() => onInstall(version)}
          disabled={disabled}
          className="btn-secondary text-xs justify-center min-w-[110px]"
        >
          {isInstalling ? (
            <>
              <Loader size={12} className="animate-spin mr-1.5" />
              Installing…
            </>
          ) : (
            <>
              <Download size={12} className="mr-1.5" />
              Install
            </>
          )}
        </button>
      </div>

      {isInstalling && (
        <div className="mt-3 px-3 py-2 bg-gray-900 rounded-lg">
          <p className="text-xs text-green-400 font-mono truncate" title={logLine}>
            {logLine || 'Starting…'}
          </p>
        </div>
      )}
    </div>
  );
}

export default function PHPVersions() {
  const [versions, setVersions] = useState([]);
  const [installable, setInstallable] = useState([]);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(null);
  const [installing, setInstalling] = useState(null);
  const [updating, setUpdating] = useState(null);
  const [logLine, setLogLine] = useState('');
  const [message, setMessage] = useState(null);

  // Keep the version of the in-flight brew op available to the progress
  // listener without re-subscribing on every change.
  const busyRef = useRef(null);
  useEffect(() => {
    busyRef.current = installing || updating;
  }, [installing, updating]);

  useEffect(() => {
    loadVersions();

    const handleProgress = (data) => {
      if (data && data.version === busyRef.current) {
        setLogLine(data.line);
      }
    };
    window.electronAPI.on('php-install-progress', handleProgress);
    return () => window.electronAPI.off('php-install-progress');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadVersions() {
    setLoading(true);
    // Load each list independently so a failure in one (e.g. an older main
    // process without the installable-versions handler) can't blank the other.
    const [installedResult, installableResult] = await Promise.allSettled([
      window.electronAPI.getPhpVersions(),
      window.electronAPI.getInstallablePhpVersions(),
    ]);
    if (installedResult.status === 'fulfilled') {
      setVersions(installedResult.value);
    } else {
      console.error(installedResult.reason);
    }
    if (installableResult.status === 'fulfilled') {
      setInstallable(installableResult.value);
    } else {
      console.error(installableResult.reason);
    }
    setLoading(false);
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

  async function handleInstall(version) {
    setInstalling(version);
    setLogLine('');
    setMessage(null);
    const result = await window.electronAPI.installPhpVersion(version);
    if (result.success) {
      setMessage({ type: 'success', text: `PHP ${version} installed.` });
      await loadVersions();
    } else {
      setMessage({ type: 'error', text: result.error });
    }
    setInstalling(null);
    setLogLine('');
  }

  async function handleUpdate(version) {
    setUpdating(version);
    setLogLine('');
    setMessage(null);
    const result = await window.electronAPI.updatePhpVersion(version);
    if (result.success) {
      setMessage({ type: 'success', text: `PHP ${version} updated.` });
      await loadVersions();
    } else {
      setMessage({ type: 'error', text: result.error });
    }
    setUpdating(null);
    setLogLine('');
  }

  const busy = !!installing || !!updating;
  const notInstalled = installable.filter((v) => !v.installed);

  return (
    <div className="p-6 max-w-3xl animate-fade-in">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold text-gray-900">PHP Versions</h1>
          <p className="text-sm text-gray-500 mt-0.5">Manage installed PHP versions</p>
        </div>
        <button
          onClick={loadVersions}
          disabled={busy}
          className="btn-secondary text-sm"
        >
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
        <div className="text-center py-12">
          <div className="w-14 h-14 rounded-xl bg-purple-50 flex items-center justify-center mx-auto mb-3">
            <Code2 size={24} className="text-purple-500" />
          </div>
          <h3 className="text-sm font-bold text-gray-700">No PHP versions found</h3>
          <p className="text-xs text-gray-400 mt-2">
            Install one below to get started.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {versions.map((v) => (
            <VersionCard
              key={v.version}
              version={v}
              onSwitch={handleSwitch}
              switching={switching}
              onUpdate={handleUpdate}
              updating={updating}
              logLine={logLine}
            />
          ))}
        </div>
      )}

      {/* Install more PHP versions */}
      {!loading && (
        <div className="mt-8">
          <div className="flex items-center gap-2 mb-3">
            <Download size={16} className="text-gray-500" />
            <h2 className="text-sm font-semibold text-gray-900">
              Install PHP versions
            </h2>
          </div>
          {notInstalled.length === 0 ? (
            installable.length > 0 && (
              <p className="text-xs text-gray-400">
                All available PHP versions are installed.
              </p>
            )
          ) : (
            <div className="space-y-3">
              {notInstalled.map((v) => (
                <InstallRow
                  key={v.version}
                  version={v.version}
                  onInstall={handleInstall}
                  installing={installing}
                  logLine={logLine}
                  disabled={busy}
                />
              ))}
            </div>
          )}
          <p className="text-xs text-gray-400 mt-3">
            Installs <span className="font-mono">php@&lt;version&gt;</span> via
            Homebrew. This can take a few minutes. PHP 8.0 and 7.4 are EOL and
            come from the <span className="font-mono">shivammathur/php</span> tap.
          </p>
        </div>
      )}
    </div>
  );
}
