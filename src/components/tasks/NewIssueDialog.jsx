import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import MarkdownComposer from './MarkdownComposer';

// "+" New issue: title, markdown body, and which repo it goes to. `repos` are
// the picker's repo options ({ repo, label }); `defaultRepo` the one the list
// is scoped to, if just one. Resolves through `onCreated(issue)`.
export default function NewIssueDialog({ repos, defaultRepo, onCreated, onClose }) {
  const [repo, setRepo] = useState(defaultRepo || repos[0]?.repo || '');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const create = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.electronAPI.tasksIssueCreate({ repo, title, body });
      if (res?.issue) onCreated(res.issue);
      else setError(res?.error?.message || 'GitHub didn’t create the issue.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <form
        className="panel w-[560px] max-w-[92vw] p-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <p className="text-[13.5px] font-semibold text-foreground">New issue</p>
        <select
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          aria-label="Repository"
          className="form-input !h-8 !py-0 text-[13px]"
        >
          {repos.map((r) => (
            <option key={r.repo} value={r.repo}>
              {r.label}
            </option>
          ))}
        </select>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          aria-label="Title"
          className="form-input"
        />
        <MarkdownComposer
          value={body}
          onChange={setBody}
          onSubmit={create}
          minHeightClassName="min-h-40"
          placeholder="Describe the issue…"
        />
        {error && <p className="text-[12px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!title.trim() || !repo || busy}>
            {busy && <Loader2 size={13} className="animate-spin" />}
            Create issue
          </button>
        </div>
      </form>
    </div>
  );
}
