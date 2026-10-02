import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  CheckCircle,
  CircleDot,
  CircleSlash,
  Loader2,
  Search,
} from 'lucide-react';
import { labelColor } from '../../lib/tasks';
import { Avatar } from './parts';

// Popovers for changing an issue: Status, Assignees and Labels. They render
// into a portal at fixed coordinates under their anchor, because the list's
// card clips its overflow. Outside click and Escape close them.

export function Popover({ anchor, onClose, width = 240, children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    const r = anchor?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    setPos({ left, top: r.bottom + 4 });
  }, [anchor, width]);

  useEffect(() => {
    const onDown = (e) => {
      if (ref.current?.contains(e.target) || anchor?.contains(e.target)) return;
      onClose();
    };
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  if (!pos) return null;
  return createPortal(
    <div
      ref={ref}
      className="fixed z-[60] panel-menu p-1 animate-fade-in"
      style={{ left: pos.left, top: pos.top, width }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body
  );
}

function MenuItem({ icon: Icon, tone, children, onClick, checked }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-[12.5px] text-foreground hover:bg-accent"
    >
      {checked !== undefined && (
        <Check size={13} className={checked ? 'text-foreground' : 'invisible'} />
      )}
      {Icon && <Icon size={13} className={tone} />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

// Close (as completed / not planned) or reopen. `onPick({ state, reason })`.
export function StatusMenu({ anchor, item, onPick, onClose }) {
  const pick = (choice) => {
    onClose();
    onPick(choice);
  };
  return (
    <Popover anchor={anchor} onClose={onClose} width={210}>
      {item.state === 'open' ? (
        <>
          <MenuItem
            icon={CheckCircle}
            tone="text-highlight"
            onClick={() => pick({ state: 'closed', reason: 'completed' })}
          >
            Close as completed
          </MenuItem>
          <MenuItem
            icon={CircleSlash}
            tone="text-muted-foreground"
            onClick={() => pick({ state: 'closed', reason: 'not_planned' })}
          >
            Close as not planned
          </MenuItem>
        </>
      ) : (
        <MenuItem
          icon={CircleDot}
          tone="text-status-running"
          onClick={() => pick({ state: 'open' })}
        >
          Reopen
        </MenuItem>
      )}
    </Popover>
  );
}

// The repo's assignable users or labels, fetched when a picker opens.
function useRepoLookup(kind, repo) {
  const [state, setState] = useState({ loading: true, items: [], error: null });
  useEffect(() => {
    let cancelled = false;
    const api = window.electronAPI;
    const call = kind === 'labels' ? api.tasksRepoLabels : api.tasksRepoAssignees;
    call({ repo }).then((res) => {
      if (cancelled) return;
      setState({
        loading: false,
        items: res?.items || [],
        error: res?.error?.message || null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [kind, repo]);
  return state;
}

// A multi-select over the repo's users or labels. Like GitHub's sidebar, the
// choice is applied when the picker closes, and only if it changed.
// `selected` is a list of keys (logins or label names); `onApply(keys)`.
export function MultiPicker({ kind, repo, anchor, selected, onApply, onClose }) {
  const { loading, items, error } = useRepoLookup(kind, repo);
  const [chosen, setChosen] = useState(() => new Set(selected));
  const [filter, setFilter] = useState('');
  const keyOf = (i) => (kind === 'labels' ? i.name : i.login);

  const close = () => {
    const next = [...chosen];
    const same =
      next.length === selected.length && next.every((k) => selected.includes(k));
    onClose();
    if (!same) onApply(next);
  };

  const toggle = (key) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Keep anything already set that the lookup doesn't list (a label since
  // deleted, an assignee who left), so applying never drops it silently.
  const known = new Set(items.map(keyOf));
  const extra = selected
    .filter((k) => !known.has(k))
    .map((k) => (kind === 'labels' ? { name: k } : { login: k }));
  const q = filter.trim().toLowerCase();
  const shown = [...items, ...extra].filter((i) => keyOf(i).toLowerCase().includes(q));

  return (
    <Popover anchor={anchor} onClose={close} width={260}>
      <div className="relative mb-1">
        <Search
          size={12}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          autoFocus
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={kind === 'labels' ? 'Filter labels' : 'Filter people'}
          className="form-input !h-7 !pl-7 !text-[12px]"
        />
      </div>
      <div className="max-h-64 overflow-y-auto">
        {loading ? (
          <div className="flex items-center gap-1.5 px-2.5 py-2 text-[12px] text-muted-foreground">
            <Loader2 size={12} className="animate-spin" /> Loading…
          </div>
        ) : error ? (
          <div className="px-2.5 py-2 text-[12px] text-destructive">{error}</div>
        ) : shown.length === 0 ? (
          <div className="px-2.5 py-2 text-[12px] text-muted-foreground">No matches.</div>
        ) : (
          shown.map((i) => {
            const key = keyOf(i);
            const color = kind === 'labels' ? labelColor(i.color) : null;
            return (
              <MenuItem key={key} checked={chosen.has(key)} onClick={() => toggle(key)}>
                <span className="flex items-center gap-2 min-w-0">
                  {kind === 'labels' ? (
                    <span
                      className="size-2.5 flex-shrink-0 rounded-full bg-muted"
                      style={color ? { backgroundColor: color } : undefined}
                    />
                  ) : (
                    <Avatar person={i} size={16} ring={false} />
                  )}
                  <span className="truncate">{key}</span>
                </span>
              </MenuItem>
            );
          })
        )}
      </div>
    </Popover>
  );
}
