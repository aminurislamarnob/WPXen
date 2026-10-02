import { useCallback, useEffect, useState } from 'react';
import { Columns3, RefreshCw, Table2 } from 'lucide-react';
import { SegmentedTabs, Tooltip } from '../ui';
import { useOpenLink } from '../../lib/useOpenLink';
import { boardColumns, projectColor } from '../../lib/tasks';
import { AvatarStack, LabelChip, StateBadge } from './parts';
import { GrantAccessBanner } from './TasksSetup';

// The Projects tab: GitHub Projects v2 owned by you and your organisations,
// as a Board (columns from the Status field) or a read-only Table of the
// project's fields. Projects need the `read:project` scope; without it the
// tab offers Grant access and loads once it lands.

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

function Card({ item, onOpen }) {
  return (
    <button
      onClick={() => onOpen(item)}
      className="w-full text-left bg-card border border-border rounded-lg shadow-sm px-3 py-2 hover:border-ring/60"
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
    </button>
  );
}

function Board({ data, onOpen }) {
  const field = data.fields.find((f) => f.id === data.statusFieldId) || null;
  const columns = boardColumns(data.items, field);
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {columns.map((col) => (
        <div
          key={col.id}
          className="w-[260px] flex-shrink-0 rounded-xl border border-border bg-tertiary/60 p-2"
        >
          <div className="flex items-center gap-2 px-1 pb-2 text-[12px] font-medium text-foreground">
            <Swatch color={col.color} />
            <span className="truncate">{col.name}</span>
            <span className="text-muted-foreground tabular-nums">{col.items.length}</span>
          </div>
          <div className="space-y-2">
            {col.items.map((item) => (
              <Card key={item.id} item={item} onOpen={onOpen} />
            ))}
          </div>
        </div>
      ))}
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

export default function ProjectsView({ siteIdFor }) {
  const openLink = useOpenLink();
  const [projects, setProjects] = useState(null); // { projects } | { error }
  const [projectId, setProjectId] = useState(() => readStored(PROJECT_KEY));
  const [view, setView] = useState(() =>
    readStored(VIEW_KEY) === 'table' ? 'table' : 'board'
  );
  const [data, setData] = useState(null); // getProject result
  const [loading, setLoading] = useState(false);

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

  const onOpen = (item) => item.url && openLink(item.url, siteIdFor(item.repo));
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
        <div className="px-4 py-12 text-center text-[13px] text-muted-foreground">
          Loading…
        </div>
      ) : list.length === 0 ? (
        <div className="bg-card border border-border rounded-xl shadow-sm px-6 py-10 text-center">
          <p className="text-[14px] font-medium text-foreground">No projects</p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            You and your organisations don’t have any GitHub Projects yet.
          </p>
        </div>
      ) : (
        <>
          {view === 'board' ? (
            <Board data={data} onOpen={onOpen} />
          ) : (
            <Table data={data} onOpen={onOpen} />
          )}
          <p className="mt-3 text-[12px] text-muted-foreground">
            {data.items.length} {data.items.length === 1 ? 'item' : 'items'}
            {data.truncated && ' · showing the first 500'}
          </p>
        </>
      )}
    </div>
  );
}
