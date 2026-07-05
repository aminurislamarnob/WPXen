import { useState, useEffect, useCallback } from 'react';
import { Loader, Save, Check, AlertTriangle } from 'lucide-react';

// Number input with an optional unit suffix rendered inside the field.
function UnitInput({ value, unit, onChange }) {
  return (
    <div className="relative">
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`form-input text-sm ${unit ? 'pr-16' : ''}`}
      />
      {unit && (
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 pointer-events-none">
          {unit}
        </span>
      )}
    </div>
  );
}

function Field({ setting, value, onChange, customized }) {
  return (
    <div>
      <label className="flex items-center gap-2 text-sm font-semibold text-gray-900 mb-1.5">
        {setting.label}
        {customized && (
          <span className="px-1.5 py-0.5 bg-wp-blue/10 text-wp-blue rounded-full text-[10px] font-medium">
            Customized
          </span>
        )}
      </label>
      <UnitInput
        value={value}
        unit={setting.unit}
        onChange={(v) => onChange(setting.key, v)}
      />
      <p className="text-xs text-gray-500 mt-1.5 leading-relaxed">
        {setting.description}
      </p>
    </div>
  );
}

export default function SitePhpSettings({ site, onSaved }) {
  const [schema, setSchema] = useState([]);
  const [values, setValues] = useState({});
  const [draft, setDraft] = useState({});
  const [phpVersion, setPhpVersion] = useState(site.phpVersion);
  const [savedVersion, setSavedVersion] = useState(site.phpVersion);
  const [installedVersions, setInstalledVersions] = useState([]);
  const [customized, setCustomized] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    const result = await window.electronAPI.getSitePhp(site.id);
    if (result.success) {
      const strValues = {};
      for (const [k, v] of Object.entries(result.values)) strValues[k] = String(v);
      setSchema(result.schema);
      setValues(strValues);
      setDraft(strValues);
      setPhpVersion(result.phpVersion);
      setSavedVersion(result.phpVersion);
      setInstalledVersions(result.installedVersions);
      setCustomized(result.customized || []);
    } else {
      setMessage({ type: 'error', text: result.error });
    }
    setLoading(false);
  }, [site.id]);

  useEffect(() => {
    load();
  }, [load]);

  const dirty =
    phpVersion !== savedVersion || JSON.stringify(draft) !== JSON.stringify(values);

  function update(key, value) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    const result = await window.electronAPI.setSitePhp(site.id, {
      phpVersion,
      settings: draft,
    });
    if (result.success) {
      setMessage({ type: 'success', text: 'PHP settings applied to this site.' });
      await load();
      onSaved?.();
    } else {
      setMessage({ type: 'error', text: result.error });
    }
    setSaving(false);
  }

  // Split fields per the reference layout: the first rows are full-width, the
  // rest flow in a two-column grid.
  const fullWidth = schema.filter((s) =>
    ['memory_limit', 'max_execution_time'].includes(s.key)
  );
  const grid = schema.filter(
    (s) => !['memory_limit', 'max_execution_time'].includes(s.key)
  );

  return (
    <div>
      <div className="flex items-start justify-between mb-5">
        <div>
          <h2 className="text-lg font-bold text-gray-900">PHP Settings</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            PHP version and ini overrides for this site only.
          </p>
        </div>
        <button
          onClick={save}
          disabled={!dirty || saving || loading}
          className="btn-primary text-sm"
        >
          {saving ? (
            <Loader size={14} className="animate-spin mr-1.5" />
          ) : (
            <Save size={14} className="mr-1.5" />
          )}
          Save
        </button>
      </div>

      {message && (
        <div
          className={`flex items-center gap-2 px-4 py-3 rounded-xl mb-4 text-sm ${
            message.type === 'error'
              ? 'bg-red-50 text-red-700'
              : 'bg-green-50 text-green-700'
          }`}
        >
          {message.type === 'error' ? <AlertTriangle size={15} /> : <Check size={15} />}
          {message.text}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader size={22} className="animate-spin text-wp-blue" />
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-surface-border shadow-card p-5 space-y-5">
          {/* PHP Version */}
          <div>
            <label className="block text-sm font-semibold text-gray-900 mb-1.5">
              PHP Version
            </label>
            <select
              value={phpVersion}
              onChange={(e) => setPhpVersion(e.target.value)}
              className="form-input w-40 text-sm"
            >
              {/* Keep the stored version selectable even if it disappeared. */}
              {!installedVersions.includes(phpVersion) && (
                <option value={phpVersion}>{phpVersion} (missing)</option>
              )}
              {installedVersions.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1.5">
              The PHP-FPM version this site&apos;s requests are routed to.
            </p>
          </div>

          {fullWidth.map((s) => (
            <div key={s.key} className="max-w-sm">
              <Field
                setting={s}
                value={draft[s.key] ?? ''}
                onChange={update}
                customized={customized.includes(s.key)}
              />
            </div>
          ))}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {grid.map((s) => (
              <Field
                key={s.key}
                setting={s}
                value={draft[s.key] ?? ''}
                onChange={update}
                customized={customized.includes(s.key)}
              />
            ))}
          </div>
        </div>
      )}

      {!loading && (
        <p className="text-xs text-gray-400 mt-3">
          Fields show the global PHP configuration until you change them here. Only values
          that differ from the global settings are saved as site overrides (applied via{' '}
          <span className="font-mono">PHP_VALUE</span> in this site&apos;s vhost) — set a
          field back to the global value to make it follow the global settings again.
        </p>
      )}

      {dirty && !loading && (
        <div className="mt-4 flex justify-end">
          <button onClick={save} disabled={saving} className="btn-primary text-sm">
            {saving ? (
              <Loader size={14} className="animate-spin mr-1.5" />
            ) : (
              <Save size={14} className="mr-1.5" />
            )}
            Save Changes
          </button>
        </div>
      )}
    </div>
  );
}
