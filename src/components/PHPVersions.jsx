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
import { Bone, Card, Row, SectionLabel, Tooltip } from './ui';
import { usePhpUpdates } from '../lib/usePhpUpdates';

// Version-number tile (like System Settings colored tiles, but numeric).
function VersionTile({ version, active }) {
  return (
    <span
      className={`icon-tile w-[30px] h-[30px] font-mono text-[11px] font-bold ${
        active ? 'bg-highlight' : 'bg-[#af52de]'
      }`}
    >
      {version}
    </span>
  );
}

function VersionRow({
  version,
  latest,
  onSwitch,
  switching,
  onUpdate,
  updating,
  logLine,
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
              <span className="flex items-center gap-1 px-1.5 py-px bg-highlight/10 text-highlight rounded-full text-[10px] font-medium">
                <Star size={9} fill="currentColor" />
                Active
              </span>
            )}
          </span>
        }
        subtitle={`${version.fullVersion}${version.socketPath ? ` · ${version.socketPath}` : ''}`}
      >
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <StatusBadge running={version.running} size="xs" />
          FPM {version.running ? 'on' : 'off'}
        </span>
        {(version.outdated || latest) && (
          <button
            onClick={() => onUpdate(version.version)}
            disabled={isLoading || isUpdating}
            className="btn-secondary"
          >
            {isUpdating ? (
              <Loader size={13} className="animate-spin" />
            ) : (
              <ArrowUpCircle size={13} />
            )}
            {latest ? `Update to ${latest}` : 'Update'}
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
        <div className="px-4 py-2 bg-tertiary border-t border-border">
          <p className="text-xs text-status-running font-mono truncate" title={logLine}>
            {logLine || 'Starting…'}
          </p>
        </div>
      )}
    </>
  );
}

// How many rows the last load showed, so the skeleton has the same height as
// the list that replaces it. Per-viewer convenience; any failure falls back.
const COUNT_KEY = 'wpxen.php.rowCounts';
function readRowCounts() {
  try {
    const v = JSON.parse(localStorage.getItem(COUNT_KEY) || 'null');
    if (v && Number.isInteger(v.installed) && Number.isInteger(v.available)) {
      return { activeIndex: 0, ...v };
    }
  } catch {
    // No saved counts (first visit, storage blocked): use the defaults.
  }
  return { installed: 3, available: 2, activeIndex: 0 };
}
function saveRowCounts(counts) {
  try {
    localStorage.setItem(COUNT_KEY, JSON.stringify(counts));
  } catch {
    // Storage unavailable: the skeleton just uses the defaults next time.
  }
}

// Text-height bars for inside a Row's title / subtitle <p>: inline-block and
// vertically centred, so the line box (and the row) keeps its real height.
const TitleBone = ({ className = '' }) => (
  <Bone className={`!inline-block align-middle h-3 ${className}`} />
);
const SubtitleBone = ({ className = '' }) => (
  <Bone className={`!inline-block align-middle h-2.5 ${className}`} />
);
const TileBone = () => (
  <Bone className="w-[30px] h-[30px] !rounded-[7px] flex-shrink-0" />
);
const ButtonBone = ({ className = '' }) => (
  <Bone className={`h-8 flex-shrink-0 ${className}`} />
);

// The 11px footnote under a Card, one bar per line of text it stands for.
// Same <p> classes as the real note, so its lines are the same height.
function NoteBone({ widths }) {
  return (
    <p className="text-[11px] mt-1.5 px-1">
      {widths.map((w, i) => (
        <span key={i} className="block">
          <Bone className={`!inline-block align-middle h-2 ${w}`} />
        </span>
      ))}
    </p>
  );
}

// The page while the first load runs: the same sections, Cards and Rows as
// the loaded page, with bars where values go.
function PhpVersionsSkeleton() {
  const { installed, available, activeIndex } = readRowCounts();
  const subtitleWidths = ['w-56', 'w-48', 'w-52', 'w-44'];
  return (
    <div role="status" aria-label="Loading PHP versions">
      <SectionLabel>Installed Versions</SectionLabel>
      <Card>
        {Array.from({ length: Math.max(1, installed) }, (_, i) => (
          <Row
            key={i}
            icon={<TileBone />}
            title={
              // 19.5px: the real title's 13px text line (×1.5); bars alone collapse it.
              <span className="flex items-center gap-2 h-[19.5px]">
                <TitleBone className="w-14" />
                {/* The active version carries its pill, and no Set Active. */}
                {i === activeIndex && (
                  <Bone className="!inline-block h-[15px] w-12 !rounded-full" />
                )}
              </span>
            }
            subtitle={
              <SubtitleBone className={subtitleWidths[i % subtitleWidths.length]} />
            }
          >
            <span className="flex items-center gap-1.5 h-4">
              <Bone className="size-1.5 !rounded-full" />
              {/* "FPM on" (the active version, usually running) is a touch
                  narrower than "FPM off". */}
              <Bone className={`h-2.5 ${i === activeIndex ? 'w-[42px]' : 'w-11'}`} />
            </span>
            {i !== activeIndex && <ButtonBone className="w-[85px]" />}
          </Row>
        ))}
      </Card>
      <NoteBone widths={['w-full', 'w-3/5']} />

      {available > 0 && (
        <div className="mt-6">
          <SectionLabel>Available to Install</SectionLabel>
          <Card>
            {Array.from({ length: available }, (_, i) => (
              <Row
                key={i}
                icon={<TileBone />}
                title={<TitleBone className="w-14" />}
                subtitle={<SubtitleBone className="w-16" />}
              >
                <ButtonBone className="w-[90px]" />
              </Row>
            ))}
          </Card>
          <NoteBone widths={['w-full', 'w-2/5']} />
        </div>
      )}
    </div>
  );
}

function InstallRow({ version, onInstall, installing, logLine, disabled }) {
  const isInstalling = installing === version;

  return (
    <>
      <Row
        icon={
          <span className="icon-tile w-[30px] h-[30px] bg-border text-muted-foreground font-mono text-[11px] font-bold">
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
        <div className="px-4 py-2 bg-tertiary border-t border-border">
          <p className="text-xs text-status-running font-mono truncate" title={logLine}>
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
  const [refreshing, setRefreshing] = useState(false);
  const [switching, setSwitching] = useState(null);
  const [installing, setInstalling] = useState(null);
  const [updating, setUpdating] = useState(null);
  const [logLine, setLogLine] = useState('');
  const [message, setMessage] = useState(null);
  // The daily check's findings: the latest release per installed version.
  const phpUpdates = usePhpUpdates();
  const latestFor = Object.fromEntries(
    (phpUpdates?.updates || []).map((u) => [u.version, u.latest])
  );

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
  }, []);

  // The skeleton is for the first load only. Later reloads (Refresh, after an
  // install or update) keep the list on screen and spin the Refresh icon.
  async function loadVersions() {
    setRefreshing(true);
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
    if (
      installedResult.status === 'fulfilled' &&
      installableResult.status === 'fulfilled'
    ) {
      saveRowCounts({
        installed: installedResult.value.length,
        activeIndex: Math.max(
          0,
          installedResult.value.findIndex((v) => v.active)
        ),
        available: installableResult.value.filter((v) => !v.installed).length,
      });
    }
    setLoading(false);
    setRefreshing(false);
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

  // `brew update` + `brew outdated` now, then reload the rows so the Update
  // buttons reflect it.
  async function handleCheckUpdates() {
    setMessage(null);
    const state = await window.electronAPI.checkPhpUpdates().catch((err) => ({
      error: err.message,
    }));
    await loadVersions();
    if (state?.error) setMessage({ type: 'error', text: state.error });
    else if (!state?.updates?.length)
      setMessage({ type: 'success', text: 'All PHP versions are up to date.' });
  }

  const busy = !!installing || !!updating;
  const checking = !!phpUpdates?.checking;
  const notInstalled = installable.filter((v) => !v.installed);

  function scrollToSettings() {
    document
      .getElementById('php-settings')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <div className="px-6 pb-6 max-w-[735px] mx-auto animate-fade-in">
      <div className="flex items-center justify-end gap-2 mb-4">
        <Tooltip label="PHP configuration">
          <button onClick={scrollToSettings} className="btn-secondary">
            <Sliders size={14} />
            Configuration
          </button>
        </Tooltip>
        <button
          onClick={handleCheckUpdates}
          disabled={busy || checking}
          className="btn-secondary"
        >
          <ArrowUpCircle size={13} className={checking ? 'animate-pulse' : ''} />
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
        <button onClick={loadVersions} disabled={busy} className="btn-secondary">
          <RefreshCw
            size={12}
            strokeWidth={2.5}
            className={busy || (refreshing && !loading) ? 'animate-spin' : ''}
          />
          Refresh
        </button>
      </div>

      {message && (
        <div
          className={`flex items-center gap-2 px-4 py-3 rounded-[10px] mb-4 text-[13px] animate-fade-in ${
            message.type === 'error'
              ? 'bg-destructive/10 text-destructive'
              : 'bg-status-running/10 text-status-running'
          }`}
        >
          <CheckCircle size={14} />
          {message.text}
        </div>
      )}

      {loading ? (
        <PhpVersionsSkeleton />
      ) : versions.length === 0 ? (
        <Card className="px-6 py-10 text-center">
          <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center mx-auto mb-3">
            <Code2 size={22} className="text-muted-foreground" />
          </div>
          <h3 className="text-[13px] font-bold text-foreground">No PHP versions found</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Install one below to get started.
          </p>
        </Card>
      ) : (
        <>
          <SectionLabel>Installed Versions</SectionLabel>
          <Card>
            {versions.map((v) => (
              <VersionRow
                key={v.version}
                version={v}
                latest={latestFor[v.version]}
                onSwitch={handleSwitch}
                switching={switching}
                onUpdate={handleUpdate}
                updating={updating}
                logLine={logLine}
              />
            ))}
          </Card>
          <p className="text-[11px] text-muted-foreground mt-1.5 px-1">
            Each site runs on its own PHP version (Sites → PHP). The active version is the
            CLI <span className="font-mono">php</span> and what phpMyAdmin runs on;
            switching it never changes a site.
            {phpUpdates?.checkedAt && (
              <>
                {' '}
                Last checked for updates{' '}
                {new Date(phpUpdates.checkedAt).toLocaleString(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
                .
              </>
            )}
          </p>
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
          <p className="text-[11px] text-muted-foreground mt-1.5 px-1">
            Installs <span className="font-mono">php@&lt;version&gt;</span> via Homebrew.
            This can take a few minutes. PHP 8.0 and 7.4 are EOL and come from the{' '}
            <span className="font-mono">shivammathur/php</span> tap.
          </p>
        </div>
      )}

      {/* Mounted from the start so its data loads alongside the list. */}
      <PhpSettings refreshKey={versions.map((v) => v.version).join(',')} />
    </div>
  );
}
