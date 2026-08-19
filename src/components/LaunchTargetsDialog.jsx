import { useEffect, useState, useCallback } from 'react';
import { X, Folder, Plus, Pencil, Trash2, CornerDownRight } from 'lucide-react';
import { ProviderIcon } from './providerIcons';
import { Button, SegmentedTabs } from './ui';

// Manage the two launch axes for a Site's Agents:
//   • "This site"        — saved Launch Targets (a pinned directory + optional
//                          flags), e.g. Claude in wp-content/plugins/foo or in a
//                          git worktree checked out beside the webroot.
//   • "Provider defaults" — the global flags typed for an Agent on every launch,
//                          e.g. `--dangerously-skip-permissions`.
//
// Nothing here launches anything; it only edits config. The pane re-reads
// targets via onChanged so its "New session" menu reflects edits immediately.
const EMPTY_DRAFT = { id: null, agentId: '', label: '', cwd: '', args: '' };

export default function LaunchTargetsDialog({
  open,
  siteId,
  sitePath,
  agents, // detected Agents only
  onClose,
  onChanged,
}) {
  const [tab, setTab] = useState('targets');
  const [targets, setTargets] = useState([]);
  const [presets, setPresets] = useState({}); // { [agentId]: { args } }
  const [draft, setDraft] = useState(null); // null = not editing
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    const [t, p] = await Promise.all([
      window.electronAPI.listLaunchTargets(siteId),
      window.electronAPI.getAgentPresets(),
    ]);
    setTargets(t || []);
    setPresets(p || {});
  }, [siteId]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setDraft(null);
    setTab('targets');
    refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && (draft ? setDraft(null) : onClose?.());
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, draft, onClose]);

  if (!open) return null;

  const agentName = (id) => agents.find((a) => a.id === id)?.name || id;

  const startAdd = () => setDraft({ ...EMPTY_DRAFT, agentId: agents[0]?.id || '' });
  const startEdit = (t) =>
    setDraft({
      id: t.id,
      agentId: t.agentId,
      label: t.label || '',
      cwd: t.cwd,
      args: t.args || '',
    });

  const pickFolder = async () => {
    const abs = await window.electronAPI.selectFolder(sitePath);
    if (!abs) return;
    // Prefer a webroot-relative path so the Target stays portable if the site
    // moves; fall back to the absolute path (e.g. a sibling worktree).
    const rel =
      sitePath && abs.startsWith(`${sitePath}/`) ? abs.slice(sitePath.length + 1) : abs;
    setDraft((d) => ({ ...d, cwd: rel }));
  };

  const saveDraft = async () => {
    setError(null);
    const res = await window.electronAPI.saveLaunchTarget(siteId, draft);
    if (res?.error) return setError(res.error);
    setTargets(res.targets);
    setDraft(null);
    onChanged?.();
  };

  const removeTarget = async (id) => {
    const res = await window.electronAPI.deleteLaunchTarget(siteId, id);
    if (res?.error) return setError(res.error);
    setTargets(res.targets);
    onChanged?.();
  };

  const setPresetArgs = async (agentId, args) => {
    const res = await window.electronAPI.setAgentPreset(agentId, args);
    if (res?.error) return setError(res.error);
    setPresets(res.presets);
    onChanged?.();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="panel w-[560px] max-w-[92vw] max-h-[86vh] flex flex-col p-0"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-4 pb-3">
          <p className="text-[14px] font-semibold text-foreground">Launch settings</p>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-4">
          <SegmentedTabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'targets', label: 'This site' },
              { value: 'defaults', label: 'Provider defaults' },
            ]}
          />
        </div>

        {error && <div className="mx-4 mt-3 text-[12px] text-destructive">{error}</div>}

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
          {tab === 'targets' &&
            (draft ? (
              <TargetForm
                draft={draft}
                agents={agents}
                sitePath={sitePath}
                inheritedArgs={presets[draft.agentId]?.args || ''}
                onChange={setDraft}
                onPickFolder={pickFolder}
                onCancel={() => setDraft(null)}
                onSave={saveDraft}
              />
            ) : (
              <TargetList
                targets={targets}
                agentName={agentName}
                onAdd={startAdd}
                onEdit={startEdit}
                onRemove={removeTarget}
              />
            ))}

          {tab === 'defaults' && (
            <ProviderDefaults
              agents={agents}
              presets={presets}
              onCommit={setPresetArgs}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── This-site Targets list ───────────────────────────────────────────────────
function TargetList({ targets, agentName, onAdd, onEdit, onRemove }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[12.5px] text-muted-foreground">
          Saved directories to launch an agent in — a plugin/theme folder or a git
          worktree.
        </p>
        <Button variant="secondary" onClick={onAdd}>
          <Plus size={14} />
          Add
        </Button>
      </div>

      {targets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-8 text-center text-[12.5px] text-muted-foreground">
          No launch targets yet.
        </div>
      ) : (
        <div className="space-y-1.5">
          {targets.map((t) => (
            <div
              key={t.id}
              className="group flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2"
            >
              <ProviderIcon
                agentId={t.agentId}
                brand
                size={16}
                className="flex-shrink-0"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[13px] text-foreground">
                  <span className="truncate font-medium">
                    {t.label || agentName(t.agentId)}
                  </span>
                  {t.args && (
                    <span className="truncate font-mono text-[11px] text-muted-foreground">
                      {t.args}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
                  <CornerDownRight size={11} className="flex-shrink-0" />
                  <span className="truncate font-mono">{t.cwd}</span>
                </div>
              </div>
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
                <button
                  onClick={() => onEdit(t)}
                  aria-label="Edit target"
                  className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
                >
                  <Pencil size={13} />
                </button>
                <button
                  onClick={() => onRemove(t.id)}
                  aria-label="Delete target"
                  className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-accent"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Add / edit a Target ──────────────────────────────────────────────────────
function TargetForm({
  draft,
  agents,
  sitePath,
  inheritedArgs,
  onChange,
  onPickFolder,
  onCancel,
  onSave,
}) {
  const set = (patch) => onChange({ ...draft, ...patch });
  return (
    <div className="space-y-3.5">
      <Field label="Agent">
        <select
          className="form-input"
          value={draft.agentId}
          onChange={(e) => set({ agentId: e.target.value })}
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Label" hint="Optional — shown on the session tab.">
        <input
          className="form-input"
          placeholder={agents.find((a) => a.id === draft.agentId)?.name || 'Name'}
          value={draft.label}
          onChange={(e) => set({ label: e.target.value })}
        />
      </Field>

      <Field
        label="Directory"
        hint="Webroot-relative (wp-content/plugins/foo) or an absolute folder."
      >
        <div className="flex gap-2">
          <input
            className="form-input flex-1 font-mono text-[12px]"
            placeholder={sitePath || 'Path'}
            value={draft.cwd}
            onChange={(e) => set({ cwd: e.target.value })}
          />
          <Button variant="secondary" onClick={onPickFolder}>
            <Folder size={14} />
            Choose
          </Button>
        </div>
      </Field>

      <Field
        label="Flags"
        hint={
          inheritedArgs
            ? `Leave empty to inherit the provider default (${inheritedArgs}).`
            : 'Optional flags appended to the command.'
        }
      >
        <input
          className="form-input font-mono text-[12px]"
          placeholder={inheritedArgs || '--flag'}
          value={draft.args}
          onChange={(e) => set({ args: e.target.value })}
        />
      </Field>

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onSave}>
          {draft.id ? 'Save' : 'Add target'}
        </Button>
      </div>
    </div>
  );
}

// ── Global per-Agent default flags ───────────────────────────────────────────
function ProviderDefaults({ agents, presets, onCommit }) {
  // Local draft so typing is smooth; commit (persist) on blur.
  const [drafts, setDrafts] = useState(() =>
    Object.fromEntries(agents.map((a) => [a.id, presets[a.id]?.args || '']))
  );
  useEffect(() => {
    setDrafts(Object.fromEntries(agents.map((a) => [a.id, presets[a.id]?.args || ''])));
  }, [agents, presets]);

  return (
    <div className="space-y-3">
      <p className="text-[12.5px] text-muted-foreground">
        Flags typed for each agent on every launch, in any site. Individual launch targets
        can override these.
      </p>
      {agents.map((a) => (
        <Field
          key={a.id}
          label={
            <span className="flex items-center gap-1.5">
              <ProviderIcon agentId={a.id} brand size={14} />
              {a.name}
            </span>
          }
        >
          <div className="flex items-center gap-2">
            <span className="font-mono text-[12px] text-muted-foreground">{a.cmd}</span>
            <input
              className="form-input flex-1 font-mono text-[12px]"
              placeholder="--flag"
              value={drafts[a.id] ?? ''}
              onChange={(e) => setDrafts((d) => ({ ...d, [a.id]: e.target.value }))}
              onBlur={() => onCommit(a.id, drafts[a.id])}
            />
          </div>
        </Field>
      ))}
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <div className="mb-1 text-[12.5px] font-medium text-foreground">{label}</div>
      {children}
      {hint && <div className="mt-1 text-[11.5px] text-muted-foreground">{hint}</div>}
    </label>
  );
}
