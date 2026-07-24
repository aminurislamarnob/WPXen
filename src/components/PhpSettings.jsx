import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, Loader, Check, Sliders } from 'lucide-react';

// A number input that saves on blur / Enter and shows a spinner + check.
function SettingInput({ value, onSave, disabled, placeholder }) {
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
    }
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        value={val}
        placeholder={placeholder}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        disabled={disabled || saving}
        className="form-input w-28 text-right text-sm"
      />
      <span className="w-4">
        {saving && <Loader size={13} className="animate-spin text-muted-foreground" />}
        {saved && <Check size={13} className="text-status-running" />}
      </span>
    </div>
  );
}

function SettingGroup({ setting, versions, onSaveOne, onSaveAll }) {
  const [open, setOpen] = useState(false);

  // The "all versions" value: the shared value if every version agrees,
  // otherwise blank (mixed) — editing it applies to every version.
  const vals = versions.map((v) => v.values[setting.key]);
  const allEqual = vals.length > 0 && vals.every((x) => x === vals[0]);
  const masterValue = allEqual ? vals[0] : '';

  return (
    <div className="settings-card">
      <div className="flex items-center justify-between gap-3 p-4">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2 text-left"
        >
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          <span className="text-sm font-semibold text-foreground">{setting.label}</span>
        </button>
        <SettingInput
          value={masterValue}
          placeholder="Set all"
          onSave={(v) => onSaveAll(setting.key, v)}
        />
      </div>
      <p className="px-4 -mt-2 pb-3 text-xs text-muted-foreground">
        {setting.description}
      </p>

      {open && (
        <div className="border-t border-border">
          {versions.map((v) => (
            <div
              key={v.version}
              className="flex items-center justify-between px-4 py-2.5 border-b border-gray-50 last:border-b-0"
            >
              <span className="text-sm text-foreground font-mono">{v.version}</span>
              <SettingInput
                value={v.values[setting.key]}
                onSave={(val) => onSaveOne(v.version, setting.key, val)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PhpSettings() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      setData(await window.electronAPI.getPhpIniSettings());
    } catch (err) {
      console.error(err);
    }
  }

  async function saveOne(version, key, value) {
    setError(null);
    const result = await window.electronAPI.setPhpIniSetting(version, key, value);
    if (!result.success) {
      setError(result.error);
      return false;
    }
    await load();
    return true;
  }

  async function saveAll(key, value) {
    setError(null);
    const result = await window.electronAPI.setPhpIniSettingAll(key, value);
    if (!result.success) {
      setError(result.error);
      return false;
    }
    await load();
    return true;
  }

  if (!data || data.versions.length === 0) return null;

  return (
    <div id="php-settings" className="mt-8 scroll-mt-4">
      <div className="flex items-center gap-2 mb-3">
        <Sliders size={16} className="text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">PHP Configuration</h2>
      </div>

      {error && (
        <div className="mb-3 px-4 py-2.5 rounded-xl bg-destructive/10 text-destructive text-sm">
          {error}
        </div>
      )}

      <div className="space-y-3">
        {data.settings.map((setting) => (
          <SettingGroup
            key={setting.key}
            setting={setting}
            versions={data.versions}
            onSaveOne={saveOne}
            onSaveAll={saveAll}
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground mt-3">
        Changes are written to a WPHerd-managed <span className="font-mono">.ini</span>{' '}
        and applied by restarting each version&apos;s PHP-FPM.
      </p>
    </div>
  );
}
