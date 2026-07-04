import { useState, useEffect, useRef } from 'react';
import {
  CheckCircle,
  Loader,
  Code2,
  Star,
  Download,
  ArrowUpCircle,
  Sliders,
  RefreshCw,
} from 'lucide-react';
import { StatusBadge } from './StatusBadge';
import PhpSettings from './PhpSettings';
import { Card, Row, SectionLabel } from './ui';

// Version-number tile (like System Settings colored tiles, but numeric).
function VersionTile({ version, active }) {
  return (
    <span
      className={`icon-tile w-[30px] h-[30px] font-mono text-[11px] font-bold ${
        active ? 'bg-accent' : 'bg-[#af52de]'
      }`}
    >
      {version}
    </span>
  );
}

function VersionRow({ version, onSwitch, switching, onUpdate, updating, logLine }) {
  const isLoading = switching === version.version;
  const isUpdating = updating === version.version;

  return (
    <>
      <Row
        icon={<VersionTile version={version.version} active={version.active} />}
        title={
          <span className="font-medium flex items-center gap-2">
            PHP {version.version}
            {version.active && (
              <span className="flex items-center gap-1 px-1.5 py-px bg-accent/10 text-accent rounded-full text-[10px] font-medium">
                <Star size={9} fill="currentColor" />
                Active
              </span>
            )}
          </span>
        }
        subtitle={`${version.fullVersion}${version.socketPath ? ` · ${version.socketPath}` : ''}`}
      >
        <span className="flex items-center gap-1.5 text-xs text-gray-500">
          <StatusBadge running={version.running} size="xs" />
          FPM {version.running ? 'on' : 'off'}
        </span>
        {version.outdated && (
          <button
            onClick={() => onUpdate(version.version)}
            disabled={isLoading || isUpdating}
            className="btn-secondary text-xs"
          >
            {isUpdating ? (
              <Loader size={11} className="animate-spin mr-1.5" />
            ) : (
              <ArrowUpCircle size={11} className="mr-1.5" />
            )}
            Update
          </button>
        )}
        {!version.active && (
          <button
            onClick={() => onSwitch(version.version)}
            disabled={isLoading || isUpdating}
            className="btn-secondary text-xs"
          >
            {isLoading ? <Loader size={11} className="animate-spin mr-1.5" /> : null}
            Set Active
          </button>
        )}
      </Row>
      {isUpdating && (
        <div className="px-4 py-2 bg-zinc-900">
          <p className="text-xs text-green-400 font-mono truncate" title={logLine}>
            {logLine || 'Starting…'}
          </p>
        </div>
      )}
    </>
  );
}

function InstallRow({ version, onInstall, installing, logLine, disabled }) {
  const isInstalling = installing === version;

  return (
    <>
      <Row
        icon={
          <span className="icon-tile w-[30px] h-[30px] bg-gray-300 text-gray-600 font-mono text-[11px] font-bold">
            {version}
          </span>
        }
        title={`PHP ${version}`}
        subtitle={`php@${version}`}
      >
        <button
          onClick={() => onInstall(version)}
          disabled={disabled}
          className="btn-secondary text-xs min-w-[90px] justify-center"
        >
          {isInstalling ? (
            <>
              <Loader size={11} className="animate-spin mr-1.5" />
              Installing…
            </>
          ) : (
            <>
              <Download size={11} className="mr-1.5" />
              Install
            </>
          )}
        </button>
      </Row>
      {isInstalling && (
        <div className="px-4 py-2 bg-zinc-900">
          <p className="text-xs text-green-400 font-mono truncate" title={logLine}>
            {logLine || 'Starting…'}
          </p>
        </div>
      )}
    </>
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

  function scrollToSettings() {
    document
      .getElementById('php-settings')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <div className="px-6 pb-6 max-w-2xl mx-auto animate-fade-in">
      <div className="flex items-center justify-end gap-2 mb-4">
        <button
          onClick={scrollToSettings}
          title="PHP configuration"
          className="btn-secondary"
        >
          <Sliders size={14} />
          Configuration
        </button>
        <button onClick={loadVersions} disabled={busy} className="btn-secondary">
          <RefreshCw size={12} strokeWidth={2.5} className={busy ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {message && (
        <div
          className={`flex items-center gap-2 px-4 py-3 rounded-[10px] mb-4 text-[13px] animate-fade-in ${
            message.type === 'error'
              ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400'
              : 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400'
          }`}
        >
          <CheckCircle size={14} />
          {message.text}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader size={22} className="animate-spin text-accent" />
        </div>
      ) : versions.length === 0 ? (
        <Card className="px-6 py-10 text-center">
          <div className="w-12 h-12 rounded-xl bg-purple-50 dark:bg-purple-500/15 flex items-center justify-center mx-auto mb-3">
            <Code2 size={22} className="text-purple-500 dark:text-purple-300" />
          </div>
          <h3 className="text-[13px] font-bold text-gray-700">No PHP versions found</h3>
          <p className="text-xs text-gray-400 mt-1">Install one below to get started.</p>
        </Card>
      ) : (
        <>
          <SectionLabel>Installed Versions</SectionLabel>
          <Card>
            {versions.map((v) => (
              <VersionRow
                key={v.version}
                version={v}
                onSwitch={handleSwitch}
                switching={switching}
                onUpdate={handleUpdate}
                updating={updating}
                logLine={logLine}
              />
            ))}
          </Card>
        </>
      )}

      {/* Install more PHP versions */}
      {!loading && notInstalled.length > 0 && (
        <div className="mt-6">
          <SectionLabel>Available to Install</SectionLabel>
          <Card>
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
          </Card>
          <p className="text-[11px] text-gray-400 mt-1.5 px-1">
            Installs <span className="font-mono">php@&lt;version&gt;</span> via Homebrew.
            This can take a few minutes. PHP 8.0 and 7.4 are EOL and come from the{' '}
            <span className="font-mono">shivammathur/php</span> tap.
          </p>
        </div>
      )}

      {!loading && <PhpSettings />}
    </div>
  );
}
