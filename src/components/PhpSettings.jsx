import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, Loader, Check, Sliders } from 'lucide-react';
import { Bone } from './ui';

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
              className="flex items-center justify-between px-4 py-2.5 border-b border-border last:border-b-0"
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

// How many setting cards the last load showed, so the skeleton matches.
const COUNT_KEY = 'wpxen.php.iniSettingCount';
function readCount() {
  try {
    const n = Number(localStorage.getItem(COUNT_KEY));
    if (Number.isInteger(n) && n > 0) return n;
  } catch {
    // Storage unavailable: fall back to the default.
  }
  return 3;
}

// The same header and `.settings-card` shells as the loaded section, with
// bars for the label, the "Set all" field and the description.
function PhpSettingsSkeleton() {
  const widths = ['w-28', 'w-36', 'w-24', 'w-32'];
  const descWidths = ['w-72', 'w-64', 'w-80', 'w-60'];
  return (
    <div className="mt-8" role="status" aria-label="Loading PHP configuration">
      <div className="flex items-center gap-2 mb-3">
        <Sliders size={16} className="text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">PHP Configuration</h2>
      </div>
      <div className="space-y-3">
        {Array.from({ length: readCount() }, (_, i) => (
          <div key={i} className="settings-card">
            <div className="flex items-center justify-between gap-3 p-4">
              <span className="flex items-center gap-2 h-5">
                <ChevronRight size={15} className="text-muted-foreground/40" />
                <Bone className={`h-3 ${widths[i % widths.length]}`} />
              </span>
              <div className="flex items-center gap-2">
                <Bone className="form-input !w-28 !bg-muted !border-transparent" />
                <span className="w-4" />
              </div>
            </div>
            <p className="px-4 -mt-2 pb-3 text-xs">
              <Bone
                className={`!inline-block align-middle h-2.5 ${descWidths[i % descWidths.length]}`}
              />
            </p>
          </div>
        ))}
      </div>
      {/* The real note has an inline monospace “.ini”, which sets its line
          height; the invisible strut gives the bar the same line. */}
      <p className="text-xs mt-3">
        <Bone className="!inline-block align-middle h-2.5 w-96" />
        <span className="font-mono invisible">.</span>
      </p>
    </div>
  );
}

// `refreshKey` changes when the installed versions do; the section reloads
// in place then, without going back to the skeleton.
export default function PhpSettings({ refreshKey = '' }) {
  const [data, setData] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    load();
  }, [refreshKey]);

  async function load() {
    try {
      const next = await window.electronAPI.getPhpIniSettings();
      setData(next);
      try {
        if (next?.settings?.length)
          localStorage.setItem(COUNT_KEY, String(next.settings.length));
      } catch {
        // Storage unavailable: the skeleton uses the default count.
      }
    } catch (err) {
      console.error(err);
    }
    setLoaded(true);
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

  if (!loaded) return <PhpSettingsSkeleton />;
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
        Changes are written to a WPXen-managed <span className="font-mono">.ini</span> and
        applied by restarting each version&apos;s PHP-FPM.
      </p>
    </div>
  );
}
