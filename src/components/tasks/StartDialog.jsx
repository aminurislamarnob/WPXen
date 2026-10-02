import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ProviderIcon } from '../providerIcons';

// Start → on an issue: pick an agent, edit the prompt, choose where the work
// happens, and launch. The main process renders the templates and inspects
// the checkout (tasks-start-inspect); starting runs the git plan and the
// launch (tasks-start), and the Agents page opens on the new Session.

const MODES = [
  {
    value: 'branch',
    label: 'New branch in place',
    hint: 'Switches the Site’s own checkout, so the .test site serves the work live.',
  },
  {
    value: 'worktree',
    label: 'New worktree',
    hint: 'A sibling folder on its own branch, saved as a Launch Target.',
  },
  { value: 'current', label: 'Current branch', hint: 'No git change.' },
];

export default function StartDialog({ issue, initialMode, onClose }) {
  const navigate = useNavigate();
  const [info, setInfo] = useState(null); // tasks-start-inspect result
  const [agents, setAgents] = useState(null);
  const [agentId, setAgentId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [branch, setBranch] = useState('');
  const [mode, setMode] = useState(initialMode || null);
  const [repoRoot, setRepoRoot] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const ref = {
    repo: issue.repo,
    number: issue.number,
    url: issue.url,
    title: issue.title,
    kind: issue.kind || 'issue',
  };

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.listAgents().then((list) => {
      if (cancelled) return;
      const usable = (list || []).filter((a) => !a.isShell && a.detected);
      setAgents(usable);
      setAgentId((id) => id || usable[0]?.id || '');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // (Re)inspect when the checkout changes: its dirty state and whether the
  // branch already exists are per checkout.
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.tasksStartInspect({ issue: ref, repoRoot }).then((res) => {
      if (cancelled) return;
      setInfo(res);
      if (res?.error) return;
      setPrompt((p) => p || res.prompt);
      setBranch((b) => b || res.branch);
      setMode((m) => m || res.mode);
      setRepoRoot((r) => r || res.checkout.repoRoot);
    });
    return () => {
      cancelled = true;
    };
    // `ref` is rebuilt every render from `issue`, which is fixed for a dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot]);

  const git = info?.git;
  const exists = git?.branchExists && branch === info?.branch;
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await window.electronAPI.tasksStart({
        issue: ref,
        agentId,
        prompt,
        mode,
        branch,
        repoRoot,
      });
      if (res?.error) return setError(res.error);
      onClose();
      navigate(`/agents/${encodeURIComponent(res.siteId)}`, {
        state: { focus: res.sessionId, nonce: Date.now() },
      });
    } finally {
      setBusy(false);
    }
  };

  const label = mode !== 'current' && exists ? `Switch to ${branch}` : 'Start →';
  const ready = info && !info.error && agentId && prompt.trim() && mode;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="panel w-[540px] max-w-[92vw] p-4 space-y-4">
        <div>
          <p className="text-[13.5px] font-semibold text-foreground">
            Start on #{issue.number}
          </p>
          <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
            {issue.title}
          </p>
        </div>

        {!info ? (
          <div className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <Loader2 size={13} className="animate-spin" /> Checking the checkout…
          </div>
        ) : info.error ? (
          <p className="text-[12.5px] text-destructive">{info.error}</p>
        ) : (
          <>
            {info.checkouts.length > 1 && (
              <Field label="Checkout">
                <select
                  value={repoRoot || ''}
                  onChange={(e) => setRepoRoot(e.target.value)}
                  className="form-input !h-8 !py-0 text-[13px]"
                >
                  {info.checkouts.map((c) => (
                    <option key={c.repoRoot} value={c.repoRoot}>
                      {c.siteName} — {c.repoRoot}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <Field label="Agent">
              {agents && agents.length === 0 ? (
                <p className="text-[12.5px] text-muted-foreground">
                  No agent CLI is installed — add one in Settings → Agents.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {(agents || []).map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => setAgentId(a.id)}
                      className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border text-[12.5px] ${
                        agentId === a.id
                          ? 'border-highlight bg-highlight/10 text-foreground'
                          : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
                      }`}
                    >
                      <ProviderIcon agentId={a.id} brand size={13} />
                      {a.name}
                    </button>
                  ))}
                </div>
              )}
            </Field>

            <Field label="Prompt">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
                className="form-input !h-auto py-2 font-mono !text-[12px] resize-y"
              />
            </Field>

            <Field label="Where">
              <div className="space-y-1.5">
                {MODES.map((m) => (
                  <label
                    key={m.value}
                    className="flex items-start gap-2 cursor-pointer text-[12.5px]"
                  >
                    <input
                      type="radio"
                      name="start-mode"
                      className="mt-0.5"
                      checked={mode === m.value}
                      onChange={() => setMode(m.value)}
                    />
                    <span>
                      <span className="text-foreground">{m.label}</span>
                      <span className="block text-[11.5px] text-muted-foreground">
                        {m.hint}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </Field>

            {mode !== 'current' && (
              <Field label="Branch">
                <input
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  className="form-input !h-8 font-mono !text-[12px]"
                />
                {exists && (
                  <p className="mt-1 text-[11.5px] text-muted-foreground">
                    This branch already exists — Start switches to it instead of creating
                    it.
                  </p>
                )}
              </Field>
            )}

            {mode === 'branch' && git?.dirty && (
              <div className="flex items-start gap-2 rounded-md bg-status-warning/10 px-3 py-2 text-[12px] text-foreground">
                <AlertTriangle
                  size={13}
                  className="mt-0.5 text-status-warning flex-shrink-0"
                />
                <span>
                  The checkout has uncommitted changes on{' '}
                  <code className="font-mono">{git.currentBranch}</code>. They’ll carry
                  over to the new branch.
                </span>
              </div>
            )}
          </>
        )}

        {error && <p className="text-[12px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!ready || busy} onClick={start}>
            {busy && <Loader2 size={13} className="animate-spin" />}
            {label}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}
