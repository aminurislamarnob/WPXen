import { useState, useEffect } from 'react';
import { Loader, Check, Gauge, RefreshCw } from 'lucide-react';
import { Toggle } from './ui';

// Number input that saves on blur / Enter with a spinner + check, mirroring
// PhpSettings' SettingInput.
function NumberField({ value, onSave, disabled, min, max }) {
  const [val, setVal] = useState(value == null ? '' : String(value));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setVal(value == null ? '' : String(value));
  }, [value]);

  async function commit() {
    const trimmed = val.trim();
    if (trimmed === '' || trimmed === String(value)) return;
    setSaving(true);
    setSaved(false);
    const ok = await onSave(trimmed);
    setSaving(false);
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } else {
      setVal(value == null ? '' : String(value));
    }
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        min={min ?? undefined}
        max={max ?? undefined}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        disabled={disabled || saving}
        className="form-input w-24 text-right text-sm"
      />
      <span className="w-4">
        {saving && <Loader size={13} className="animate-spin text-gray-400" />}
        {saved && <Check size={13} className="text-wp-green" />}
      </span>
    </div>
  );
}

function LiveStats({ version, onLoad }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    setStats(await onLoad(version));
    setLoading(false);
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const reasonText = {
    'fpm-not-running': 'Start PHP-FPM on this version to see live stats.',
    'no-site': `Start a site on PHP ${version} to see live stats.`,
    'parse-error': "Couldn't read live stats.",
    'probe-failed': "Couldn't reach the site to read live stats.",
  };

  return (
    <div className="mt-3 rounded-xl bg-gray-50 px-3.5 py-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          Live (PHP-FPM)
        </span>
        <button
          onClick={refresh}
          disabled={loading}
          className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-800 disabled:opacity-50"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {loading && !stats ? (
        <p className="text-xs text-gray-400">Reading OpCache…</p>
      ) : stats && stats.available && stats.enabled ? (
        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat
            label="Hit rate"
            value={stats.hitRate == null ? '—' : `${stats.hitRate}%`}
          />
          <Stat
            label="Memory"
            value={
              stats.usedMB == null
                ? '—'
                : `${stats.usedMB}${stats.totalMB != null ? ` / ${stats.totalMB}` : ''} MB`
            }
          />
          <Stat
            label="Scripts"
            value={stats.cachedScripts == null ? '—' : stats.cachedScripts.toLocaleString()}
          />
        </div>
      ) : stats && stats.available && !stats.enabled ? (
        <p className="text-xs text-gray-400">OpCache is loaded but disabled.</p>
      ) : (
        <p className="text-xs text-gray-400">
          {(stats && reasonText[stats.reason]) || 'Live stats unavailable.'}
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <p className="text-sm font-semibold text-gray-900 tabular-nums">{value}</p>
      <p className="text-[11px] text-gray-400 mt-0.5">{label}</p>
    </div>
  );
}

function VersionCard({ setting, version, values, available, isRunning, onSave, onLoadLive }) {
  const bools = setting.filter((s) => s.type === 'bool');
  const ints = setting.filter((s) => s.type === 'int');
  const enabled = !!values.enable;

  return (
    <div className="settings-card p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-gray-900 font-mono">PHP {version}</span>
        {available ? (
          <Toggle
            checked={enabled}
            onChange={(v) => onSave(version, 'enable', v)}
            label={`Enable OpCache for PHP ${version}`}
          />
        ) : (
          <span className="text-xs text-gray-400">Extension not loaded</span>
        )}
      </div>

      {available && (
        <>
          <div className="mt-3 space-y-2.5">
            {ints.map((s) => (
              <div key={s.key} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[13px] text-gray-700">
                    {s.label}
                    {s.unit ? ` (${s.unit})` : ''}
                  </p>
                </div>
                <NumberField
                  value={values[s.key]}
                  min={s.min}
                  max={s.max}
                  disabled={!enabled}
                  onSave={(v) => onSave(version, s.key, v)}
                />
              </div>
            ))}
            {bools
              .filter((s) => s.key !== 'enable')
              .map((s) => (
                <div key={s.key} className="flex items-center justify-between gap-3">
                  <p className="text-[13px] text-gray-700">{s.label}</p>
                  <Toggle
                    checked={!!values[s.key]}
                    disabled={!enabled}
                    onChange={(v) => onSave(version, s.key, v)}
                    label={s.label}
                  />
                </div>
              ))}
          </div>

          {isRunning && <LiveStats version={version} onLoad={onLoadLive} />}
        </>
      )}
    </div>
  );
}

export default function OpCache() {
  const [config, setConfig] = useState(null);
  const [applyAll, setApplyAll] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      const res = await window.electronAPI.getOpcacheConfig();
      if (res.success) setConfig(res);
      else setError(res.error);
    } catch (err) {
      console.error(err);
    }
  }

  async function save(version, key, value) {
    setError(null);
    const res = applyAll
      ? await window.electronAPI.setOpcacheAll(key, value)
      : await window.electronAPI.setOpcache(version, key, value);
    if (!res.success) {
      setError(res.error);
      return false;
    }
    await load();
    return true;
  }

  async function loadLive(version) {
    const res = await window.electronAPI.getOpcacheLiveStats(version);
    return res.success ? res.stats : { available: false, reason: 'probe-failed' };
  }

  if (!config || config.versions.length === 0) return null;

  return (
    <div id="opcache-settings" className="mt-8 scroll-mt-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Gauge size={16} className="text-gray-500" />
          <h2 className="text-sm font-semibold text-gray-900">OpCache</h2>
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-500 select-none cursor-pointer">
          Apply to all versions
          <Toggle
            checked={applyAll}
            onChange={setApplyAll}
            label="Apply OpCache changes to all versions"
          />
        </label>
      </div>

      {error && (
        <div className="mb-3 px-4 py-2.5 rounded-xl bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400 text-sm">
          {error}
        </div>
      )}

      <div className="space-y-3">
        {config.versions.map((v) => (
          <VersionCard
            key={v.version}
            setting={config.settings}
            version={v.version}
            values={v.values}
            available={v.available}
            isRunning={v.version === config.runningVersion}
            onSave={save}
            onLoadLive={loadLive}
          />
        ))}
      </div>
      <p className="text-xs text-gray-400 mt-3">
        Changes are written to a WPHerd-managed{' '}
        <span className="font-mono">zz-wpherd-opcache.ini</span> and applied by reloading
        PHP-FPM. Live stats read the running FPM pool through one of its sites.
      </p>
    </div>
  );
}
