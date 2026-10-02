import { useState } from 'react';
import { X } from 'lucide-react';
import { applyFilters, parseFilters } from '../../lib/tasks';
import { Popover } from './pickers';

// Filters (Status, Author, Assignee, Label) as a form over the query text.
// It reads the search box's draft and writes qualifiers straight back into
// it, so the box always shows what's applied; the search runs when the
// dropdown closes, the same moment a typed query runs on Enter.

const STATUSES = {
  issue: [
    { value: 'open', label: 'Open' },
    { value: 'closed', label: 'Closed' },
    { value: 'all', label: 'All' },
  ],
  pr: [
    { value: 'open', label: 'Open' },
    { value: 'closed', label: 'Closed' },
    { value: 'merged', label: 'Merged' },
    { value: 'all', label: 'All' },
  ],
};

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

// `kind` 'issue' filters by Assignee; 'pr' by Reviewer (review-requested:)
// and can pick Merged.
export default function FiltersMenu({ kind = 'issue', anchor, draft, onDraft, onClose }) {
  const person = kind === 'pr' ? 'reviewer' : 'assignee';
  const filters = parseFilters(draft);
  const [labelInput, setLabelInput] = useState('');
  const set = (patch) => onDraft(applyFilters(draft, { ...filters, ...patch }));

  const addLabel = () => {
    const l = labelInput.trim();
    if (l && !filters.labels.includes(l)) set({ labels: [...filters.labels, l] });
    setLabelInput('');
  };

  return (
    <Popover anchor={anchor} onClose={onClose} width={280}>
      <div className="space-y-3 p-2">
        <Field label="Status">
          <div className="flex gap-1">
            {STATUSES[kind].map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => set({ status: s.value })}
                className={`h-7 flex-1 rounded-md text-[12px] font-medium ${
                  filters.status === s.value
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Author">
          <input
            value={filters.author}
            onChange={(e) => set({ author: e.target.value.replace(/\s/g, '') })}
            onKeyDown={(e) => e.key === 'Enter' && onClose()}
            placeholder="login"
            className="form-input !h-7 !text-[12px]"
          />
        </Field>
        <Field label={kind === 'pr' ? 'Reviewer' : 'Assignee'}>
          <div className="flex gap-1">
            <input
              value={filters[person]}
              onChange={(e) => set({ [person]: e.target.value.replace(/\s/g, '') })}
              onKeyDown={(e) => e.key === 'Enter' && onClose()}
              placeholder="login"
              className="form-input !h-7 !text-[12px] flex-1"
            />
            <button
              type="button"
              className="btn btn-secondary !h-7 !px-2 !text-[12px]"
              onClick={() => set({ [person]: filters[person] === '@me' ? '' : '@me' })}
            >
              Me
            </button>
          </div>
        </Field>
        <Field label="Labels">
          {filters.labels.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1">
              {filters.labels.map((l) => (
                <span
                  key={l}
                  className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 text-[11px] text-foreground"
                >
                  {l}
                  <button
                    type="button"
                    aria-label={`Remove ${l}`}
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => set({ labels: filters.labels.filter((x) => x !== l) })}
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <input
            value={labelInput}
            onChange={(e) => setLabelInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addLabel();
              }
            }}
            onBlur={addLabel}
            placeholder="Add a label, then Enter"
            className="form-input !h-7 !text-[12px]"
          />
        </Field>
      </div>
    </Popover>
  );
}
