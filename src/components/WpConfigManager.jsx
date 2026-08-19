import { useState, useEffect, useCallback } from 'react';
import { Loader, Save, FileCode2, Check, AlertTriangle, RotateCcw } from 'lucide-react';

function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${
        checked ? 'bg-highlight' : 'bg-border'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

export default function WpConfigManager({ site }) {
  const [schema, setSchema] = useState([]);
  const [values, setValues] = useState({});
  const [draft, setDraft] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [manual, setManual] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    const result = await window.electronAPI.getWpConfig(site.id);
    if (result.success) {
      setSchema(result.schema);
      setValues(result.values);
      setDraft(result.values);
    } else {
      setMessage({ type: 'error', text: result.error });
    }
    setLoading(false);
  }, [site.id]);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(values);

  function update(key, value) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    // Only send the keys that actually changed.
    const changes = {};
    for (const key of Object.keys(draft)) {
      if (draft[key] !== values[key]) changes[key] = draft[key];
    }
    const result = await window.electronAPI.setWpConfig(site.id, changes);
    if (result.success) {
      setValues(result.values);
      setDraft(result.values);
      setMessage({ type: 'success', text: 'wp-config.php updated.' });
    } else {
      setMessage({ type: 'error', text: result.error });
    }
    setSaving(false);
  }

  if (manual) {
    return <ManualEditor site={site} onClose={() => setManual(false)} onSaved={load} />;
  }

  return (
    <div>
      <div className="flex items-start justify-between mb-5">
        <div>
          <h2 className="text-lg font-bold text-foreground">WP Config Manager</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage common <span className="font-mono">wp-config.php</span> constants.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setManual(true)} className="btn-secondary text-sm">
            <FileCode2 size={14} className="mr-1.5" />
            Edit Manually
          </button>
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
      </div>

      {message && (
        <div
          className={`flex items-center gap-2 px-4 py-3 rounded-xl mb-4 text-sm ${
            message.type === 'error'
              ? 'bg-destructive/10 text-destructive'
              : 'bg-status-running/10 text-status-running'
          }`}
        >
          {message.type === 'error' ? <AlertTriangle size={15} /> : <Check size={15} />}
          {message.text}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader size={22} className="animate-spin text-highlight" />
        </div>
      ) : (
        <div className="settings-card divide-y divide-border">
          {schema.map((setting) => {
            const blocked = setting.dependsOn && !draft[setting.dependsOn];
            const depLabel =
              blocked &&
              (schema.find((s) => s.key === setting.dependsOn)?.label ||
                'its dependency');
            return (
              <div
                key={setting.key}
                className={`flex items-start justify-between gap-6 px-5 py-4 ${
                  blocked ? 'opacity-60' : ''
                }`}
              >
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-foreground">
                    {setting.label}
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    {setting.description}
                  </p>
                  {blocked && (
                    <p className="text-xs text-status-warning mt-1 font-medium">
                      Requires “{depLabel}” to be enabled.
                    </p>
                  )}
                </div>
                <div className="flex-shrink-0 pt-0.5">
                  {setting.type === 'bool' ? (
                    <Toggle
                      checked={!blocked && !!draft[setting.key]}
                      onChange={(v) => update(setting.key, v)}
                      disabled={blocked}
                    />
                  ) : (
                    <select
                      value={draft[setting.key] ?? setting.default}
                      onChange={(e) => update(setting.key, e.target.value)}
                      className="form-input w-56 text-sm py-1.5"
                    >
                      {setting.options.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            );
          })}
        </div>
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

function ManualEditor({ site, onClose, onSaved }) {
  const [contents, setContents] = useState('');
  const [original, setOriginal] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const result = await window.electronAPI.getWpConfigRaw(site.id);
      if (result.success) {
        setContents(result.contents);
        setOriginal(result.contents);
      } else {
        setMessage({ type: 'error', text: result.error });
      }
      setLoading(false);
    })();
  }, [site.id]);

  async function save() {
    setSaving(true);
    setMessage(null);
    const result = await window.electronAPI.saveWpConfigRaw(site.id, contents);
    if (result.success) {
      setOriginal(contents);
      setMessage({ type: 'success', text: 'wp-config.php saved (a .bak was kept).' });
      onSaved?.();
    } else {
      setMessage({ type: 'error', text: result.error });
    }
    setSaving(false);
  }

  return (
    <div>
      <div className="flex items-start justify-between mb-5">
        <div>
          <h2 className="text-lg font-bold text-foreground">Edit wp-config.php</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Direct file editing. A <span className="font-mono">.bak</span> copy is kept on
            save.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="btn-secondary text-sm">
            <RotateCcw size={14} className="mr-1.5" />
            Back to toggles
          </button>
          <button
            onClick={save}
            disabled={saving || loading || contents === original}
            className="btn-primary text-sm"
          >
            {saving ? (
              <Loader size={14} className="animate-spin mr-1.5" />
            ) : (
              <Save size={14} className="mr-1.5" />
            )}
            Save File
          </button>
        </div>
      </div>

      {message && (
        <div
          className={`flex items-center gap-2 px-4 py-3 rounded-xl mb-4 text-sm ${
            message.type === 'error'
              ? 'bg-destructive/10 text-destructive'
              : 'bg-status-running/10 text-status-running'
          }`}
        >
          {message.type === 'error' ? <AlertTriangle size={15} /> : <Check size={15} />}
          {message.text}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader size={22} className="animate-spin text-highlight" />
        </div>
      ) : (
        <textarea
          value={contents}
          onChange={(e) => setContents(e.target.value)}
          spellCheck={false}
          className="w-full h-[26rem] font-mono text-xs p-4 rounded-lg border border-border bg-background text-foreground resize-y scrollbar-thin"
        />
      )}
    </div>
  );
}
