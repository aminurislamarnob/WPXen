import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Columns3, RefreshCw, Table2, X } from 'lucide-react';
import { SegmentedTabs, Tooltip } from '../ui';
import { useOpenLink } from '../../lib/useOpenLink';
import {
  NO_STATUS,
  boardColumns,
  hasScope,
  moveItem,
  projectColor,
  sessionsFor,
} from '../../lib/tasks';
import { AvatarStack, LabelChip, StartButton, StateBadge } from './parts';
import { Markdown } from './markdown';
import { BoardSkeleton, ListSkeleton } from './skeletons';
import { GrantAccessBanner } from './TasksSetup';

// The Projects tab: GitHub Projects v2 owned by you and your organisations,
// as a Board (columns from the Status field) or a read-only Table of the
// project's fields. Projects need the `read:project` scope; without it the
// tab offers Grant access and loads once it lands.
//
// On the Board, dragging a card to another column sets its Status — shown at
// once, rolled back with a message if GitHub refuses. That write needs the
// `project` scope, asked for before the first move. Issue and PR items open
// their Tasks details; drafts show their body; Start → appears on items whose
// repo is checked out in a Site.

const PROJECT_KEY = 'wpxen.tasks.project';
const VIEW_KEY = 'wpxen.tasks.projectView';

function readStored(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable — the choice just won't be remembered
  }
}

function Swatch({ color }) {
  const c = projectColor(color);
  return (
    <span
      className="size-2.5 flex-shrink-0 rounded-full bg-muted"
      style={c ? { backgroundColor: c } : undefined}
    />
  );
}

function ItemRef({ item }) {
  if (item.kind === 'draft') return <span className="text-muted-foreground">Draft</span>;
  if (!item.repo) return null;
  return (
    <span className="font-mono text-[10.5px] text-muted-foreground truncate">
      {item.repo}#{item.number}
    </span>
  );
}

// Drag payload type — our own, so a dropped file or link is ignored.
const DRAG_TYPE = 'application/x-wpxen-project-item';

function Card({ item, onOpen, draggable, start }) {
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, item.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => onOpen(item)}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(item)}
      className={`w-full text-left bg-card border border-border rounded-lg shadow-sm px-3 py-2 hover:border-ring/60 ${
        draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
      }`}
    >
      <div className="text-[12.5px] font-medium text-foreground leading-snug line-clamp-3">
        {item.title}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 min-w-0">
        <ItemRef item={item} />
        <div className="flex-1" />
        {item.assignees.length > 0 && <AvatarStack people={item.assignees} max={3} />}
      </div>
      {item.labels.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {item.labels.slice(0, 4).map((l) => (
            <LabelChip key={l.name} label={l} />
          ))}
        </div>
      )}
      {start && <div className="mt-2 flex justify-end">{start}</div>}
    </div>
  );
}

// `onMove(item, option)` when a card is dropped on another column (option
// null = No Status). Without a Status field there's nothing to move between.
function Board({ data, onOpen, onMove, renderStart }) {
  const field = data.fields.find((f) => f.id === data.statusFieldId) || null;
  const columns = boardColumns(data.items, field);
  const [over, setOver] = useState(null); // column id under a drag
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {columns.map((col) => (
        <div
          key={col.id}
          onDragOver={(e) => {
            if (!field || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setOver(col.id);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) setOver(null);
          }}
          onDrop={(e) => {
            setOver(null);
            const id = e.dataTransfer.getData(DRAG_TYPE);
            const item = data.items.find((i) => i.id === id);
            if (!field || !item) return;
            e.preventDefault();
            const option =
              col.id === NO_STATUS ? null : field.options.find((o) => o.id === col.id);
            const currentId = item.values[field.id]?.optionId || null;
            if ((option?.id || null) !== currentId) onMove(item, field, option || null);
          }}
          className={`w-[260px] flex-shrink-0 rounded-xl border p-2 transition-colors ${
            over === col.id
              ? 'border-highlight bg-highlight/5'
              : 'border-border bg-tertiary/60'
          }`}
        >
          <div className="flex items-center gap-2 px-1 pb-2 text-[12px] font-medium text-foreground">
            <Swatch color={col.color} />
            <span className="truncate">{col.name}</span>
            <span className="text-muted-foreground tabular-nums">{col.items.length}</span>
          </div>
          <div className="space-y-2 min-h-[40px]">
            {col.items.map((item) => (
              <Card
                key={item.id}
                item={item}
                onOpen={onOpen}
                draggable={!!field}
                start={renderStart(item)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// A draft has no page anywhere — its title and body are all there is.
function DraftDialog({ item, onLink, onClose }) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="panel w-[520px] max-w-[92vw] p-4 space-y-3">
        <div className="flex items-center gap-2">
          <span className="rounded-sm border border-border px-1 text-[10.5px] text-muted-foreground">
            Draft
          </span>
          <p className="text-[13.5px] font-semibold text-foreground">{item.title}</p>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          <Markdown text={item.body} onLink={onLink} empty="No description." />
        </div>
        <div className="flex justify-end">
          <button autoFocus className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function Table({ data, onOpen }) {
  const fields = data.fields;
  return (
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-x-auto">
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="px-3 h-9 font-medium">Title</th>
            <th className="px-3 h-9 font-medium">Assignees</th>
            {fields.map((f) => (
              <th key={f.id} className="px-3 h-9 font-medium whitespace-nowrap">
                {f.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.items.map((item) => (
            <tr
              key={item.id}
              onClick={() => onOpen(item)}
              className="border-b border-border last:border-b-0 cursor-pointer hover:bg-accent/50"
            >
              <td className="px-3 py-2 max-w-[360px]">
                <div className="flex items-center gap-1.5 min-w-0">
                  {item.state && <StateBadge item={item} />}
                  <span className="truncate text-foreground">{item.title}</span>
                </div>
                <ItemRef item={item} />
              </td>
              <td className="px-3 py-2">
                <AvatarStack people={item.assignees} max={3} />
              </td>
              {fields.map((f) => {
                const v = item.values[f.id];
                const option = v?.optionId && f.options.find((o) => o.id === v.optionId);
                return (
                  <td key={f.id} className="px-3 py-2 whitespace-nowrap text-foreground">
                    {option ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Swatch color={option.color} />
                        {option.name}
                      </span>
                    ) : (
                      v?.text || <span className="text-muted-foreground">–</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ProjectsView({
  siteIdFor,
  onOpenItem,
  linked,
  onStart,
  onOpenSession,
}) {
  const openLink = useOpenLink();
  const [projects, setProjects] = useState(null); // { projects } | { error }
  const [projectId, setProjectId] = useState(() => readStored(PROJECT_KEY));
  const [view, setView] = useState(() =>
    readStored(VIEW_KEY) === 'table' ? 'table' : 'board'
  );
  const [data, setData] = useState(null); // getProject result
  const [loading, setLoading] = useState(false);
  const [moveError, setMoveError] = useState(null);
  const [needScope, setNeedScope] = useState(null); // 'project' while asking
  const [draft, setDraft] = useState(null); // a draft item being read
  // The login's scopes, to ask for `project` before the first move rather
  // than after a failed one. null scopes (unknown) → just try.
  const [preflight, setPreflight] = useState(null);
  useEffect(() => {
    window.electronAPI.tasksPreflight().then(setPreflight);
  }, []);

  const loadProjects = useCallback(async ({ force = false } = {}) => {
    setProjects(await window.electronAPI.tasksProjects({ force }));
  }, []);
  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const list = projects?.projects || [];
  // The remembered project if it's still there, else the most recent one.
  const current = list.find((p) => p.id === projectId) || list[0] || null;

  const loadProject = useCallback(
    async ({ force = false } = {}) => {
      if (!current) return setData(null);
      setLoading(true);
      try {
        setData(await window.electronAPI.tasksProject({ id: current.id, force }));
      } finally {
        setLoading(false);
      }
    },
    [current?.id] // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    loadProject();
  }, [loadProject]);

  useEffect(() => {
    if (current) writeStored(PROJECT_KEY, current.id);
  }, [current]);
  useEffect(() => writeStored(VIEW_KEY, view), [view]);

  const onLink = (url) => openLink(url);
  const onOpen = (item) => {
    if (item.kind === 'draft') setDraft(item);
    else if (item.kind === 'issue' || item.kind === 'pr') onOpenItem(item);
  };

  // Optimistic: the card moves now; GitHub's refusal puts it back.
  const onMove = async (item, field, option) => {
    setMoveError(null);
    if (!hasScope(preflight, 'project')) {
      setNeedScope('project');
      return;
    }
    const before = data;
    setData((d) => moveItem(d, item.id, field.id, option));
    const res = await window.electronAPI.tasksProjectMove({
      projectId: current.id,
      itemId: item.id,
      fieldId: field.id,
      optionId: option?.id ?? null,
    });
    if (res?.error) {
      setData(before);
      if (res.error.code === 'missing-scope') setNeedScope(res.error.scope || 'project');
      else setMoveError(`Couldn’t move “${item.title}”: ${res.error.message}`);
    }
  };

  // Start → for open issues and PRs whose repo is checked out in a Site.
  const renderStart = (item) =>
    (item.kind === 'issue' || item.kind === 'pr') &&
    item.state === 'open' &&
    siteIdFor(item.repo) ? (
      <StartButton
        sessions={sessionsFor(linked, item)}
        onStart={() => onStart(item)}
        onOpenSession={onOpenSession}
      />
    ) : null;
  const refresh = () => {
    loadProjects({ force: true });
    loadProject({ force: true });
  };

  const error = projects?.error || data?.error;
  if (error?.code === 'missing-scope') {
    return (
      <GrantAccessBanner
        scope={error.scope || 'read:project'}
        reason="GitHub Projects need it, and gh doesn’t ask for it at sign-in. Granting adds it to your existing gh login."
        onGranted={refresh}
      />
    );
  }

  // Projects grouped by owner, yours first.
  const owners = [...new Set(list.map((p) => p.owner))];

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        {list.length > 0 && (
          <select
            value={current?.id || ''}
            onChange={(e) => setProjectId(e.target.value)}
            aria-label="Project"
            className="form-input !h-8 !w-auto max-w-[320px] !py-0 text-[13px]"
          >
            {owners.map((owner) => (
              <optgroup key={owner} label={owner}>
                {list
                  .filter((p) => p.owner === owner)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title}
                      {p.closed ? ' (closed)' : ''}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        )}
        <SegmentedTabs
          tabs={[
            { value: 'board', label: 'Board', icon: Columns3 },
            { value: 'table', label: 'Table', icon: Table2 },
          ]}
          value={view}
          onChange={setView}
        />
        <div className="flex-1" />
        <Tooltip label="Refresh">
          <button
            onClick={refresh}
            aria-label="Refresh"
            className="btn btn-secondary !px-2"
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </Tooltip>
      </div>

      {error ? (
        <div className="bg-card border border-border rounded-xl shadow-sm px-6 py-10 text-center">
          <p className="text-[14px] font-medium text-foreground">
            Couldn’t load projects
          </p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">{error.message}</p>
          <button className="btn btn-secondary mt-4" onClick={refresh}>
            Try again
          </button>
        </div>
      ) : !projects || (current && !data) ? (
        view === 'table' ? (
          <ListSkeleton rows={8} />
        ) : (
          <BoardSkeleton />
        )
      ) : list.length === 0 ? (
        <div className="bg-card border border-border rounded-xl shadow-sm px-6 py-10 text-center">
          <p className="text-[14px] font-medium text-foreground">No projects</p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            You and your organisations don’t have any GitHub Projects yet.
          </p>
        </div>
      ) : (
        <>
          {needScope && (
            <div className="mb-3">
              <GrantAccessBanner
                scope={needScope}
                reason="Moving cards writes to the project, which needs the project scope."
                onGranted={(pre) => {
                  setPreflight(pre);
                  setNeedScope(null);
                }}
              />
            </div>
          )}
          {moveError && (
            <div className="mb-3 flex items-center gap-2 rounded-md border border-border bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
              <AlertTriangle size={13} />
              <span className="flex-1">{moveError}</span>
              <button
                aria-label="Dismiss"
                className="hover:text-foreground"
                onClick={() => setMoveError(null)}
              >
                <X size={13} />
              </button>
            </div>
          )}
          {view === 'board' ? (
            <Board
              data={data}
              onOpen={onOpen}
              onMove={onMove}
              renderStart={renderStart}
            />
          ) : (
            <Table data={data} onOpen={onOpen} />
          )}
          <p className="mt-3 text-[12px] text-muted-foreground">
            {data.items.length} {data.items.length === 1 ? 'item' : 'items'}
            {data.truncated && ' · showing the first 500'}
          </p>
        </>
      )}
      {draft && (
        <DraftDialog item={draft} onLink={onLink} onClose={() => setDraft(null)} />
      )}
    </div>
  );
}
