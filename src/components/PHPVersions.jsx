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
  Bug,
} from 'lucide-react';
import { StatusBadge } from './StatusBadge';
import PhpSettings from './PhpSettings';
import { Card, Row, SectionLabel, Toggle } from './ui';

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

function VersionRow({
  version,
  onSwitch,
  switching,
  onUpdate,
  updating,
  logLine,
  xdebug,
  xdebugInstalling,
  xdebugBusy,
  xdebugLogLine,
  onInstallXdebug,
  onToggleXdebug,
  onSetXdebugMode,
}) {
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

      {/* Xdebug sub-row */}
      {xdebug && (
        <div className="flex items-center gap-3 px-4 py-2.5 border-t border-surface-hairline">
          <span className="w-[30px] flex justify-center flex-shrink-0">
            <Bug size={15} className="text-gray-400" />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] text-gray-900">Xdebug</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {xdebug.installed
                ? `Listens on localhost:${xdebug.clientPort || 9003}`
                : 'Step debugging & develop helpers'}
            </p>
          </div>
          {!xdebug.installed ? (
            <button
              onClick={() => onInstallXdebug(version.version)}
              disabled={xdebugInstalling}
              className="btn-secondary text-xs min-w-[90px] justify-center"
            >
              {xdebugInstalling ? (
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
          ) : (
            <div className="flex items-center gap-2">
              {xdebug.enabled && (
                <select
                  value={xdebug.mode}
                  onChange={(e) => onSetXdebugMode(version.version, e.target.value)}
                  disabled={xdebugBusy}
                  className="form-input !w-auto !py-1 text-xs"
                >
                  <option value="debug">Debug</option>
                  <option value="develop">Develop</option>
                  <option value="debug,develop">Debug + Develop</option>
                </select>
              )}
              {xdebugBusy ? (
                <Loader size={14} className="animate-spin text-gray-400" />
              ) : (
                <Toggle
                  checked={xdebug.enabled}
                  onChange={(v) => onToggleXdebug(version.version, v)}
                  label="Xdebug"
                />
              )}
            </div>
          )}
        </div>
      )}
      {xdebugInstalling && (
        <div className="px-4 py-2 bg-zinc-900">
          <p className="text-xs text-green-400 font-mono truncate" title={xdebugLogLine}>
            {xdebugLogLine || 'Starting…'}
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
  const [xdebugStates, setXdebugStates] = useState({});
  const [xdebugInstalling, setXdebugInstalling] = useState(null);
  const [xdebugBusy, setXdebugBusy] = useState(null);

  // Keep the version of the in-flight brew op available to the progress
  // listener without re-subscribing on every change.
  const busyRef = useRef(null);
  useEffect(() => {
    busyRef.current = installing || updating || xdebugInstalling;
  }, [installing, updating, xdebugInstalling]);

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
    loadXdebug();
    setLoading(false);
  }

  async function loadXdebug() {
    try {
      const r = await window.electronAPI.getXdebugStatus();
      if (r?.success) {
        const map = {};
        for (const s of r.versions) map[s.version] = s;
        setXdebugStates(map);
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function handleInstallXdebug(version) {
    setXdebugInstalling(version);
    setLogLine('');
    setMessage(null);
    const result = await window.electronAPI.installXdebug(version);
    if (result.success) {
      setMessage({ type: 'success', text: `Xdebug installed for PHP ${version}.` });
      setXdebugStates((prev) => ({ ...prev, [version]: result.state }));
    } else {
      setMessage({ type: 'error', text: result.error });
    }
    setXdebugInstalling(null);
    setLogLine('');
  }

  async function handleToggleXdebug(version, enabled) {
    setXdebugBusy(version);
    const result = await window.electronAPI.setXdebug(version, { enabled });
    if (result.success) {
      setXdebugStates((prev) => ({ ...prev, [version]: result.state }));
    } else {
      setMessage({ type: 'error', text: result.error });
    }
    setXdebugBusy(null);
  }

  async function handleSetXdebugMode(version, mode) {
    setXdebugBusy(version);
    const current = xdebugStates[version];
    const result = await window.electronAPI.setXdebug(version, {
      enabled: current?.enabled ?? true,
      mode,
    });
    if (result.success) {
      setXdebugStates((prev) => ({ ...prev, [version]: result.state }));
    } else {
      setMessage({ type: 'error', text: result.error });
    }
    setXdebugBusy(null);
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
    <div className="px-6 pb-6 max-w-[735px] mx-auto animate-fade-in">
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
                xdebug={xdebugStates[v.version]}
                xdebugInstalling={xdebugInstalling === v.version}
                xdebugBusy={xdebugBusy === v.version}
                xdebugLogLine={logLine}
                onInstallXdebug={handleInstallXdebug}
                onToggleXdebug={handleToggleXdebug}
                onSetXdebugMode={handleSetXdebugMode}
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
