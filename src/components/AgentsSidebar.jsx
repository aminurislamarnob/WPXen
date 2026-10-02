import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  ChevronRight,
  ChevronDown,
  ChevronLeft,
  Globe,
  GitBranch,
  Plus,
  X,
  FolderPlus,
  FolderMinus,
  SlidersHorizontal,
  Check,
  Bell,
  BellOff,
} from 'lucide-react';
import { ProviderIcon } from './providerIcons';
import { Tooltip, ConfirmDialog } from './ui';
import LaunchMenu from './LaunchMenu';
import AgentStatusGlyph from './AgentStatusGlyph';
import {
  buildProjects,
  buildActivity,
  formatAge,
  mostUrgent,
  applyListOptions,
  activeFilterCount,
  DEFAULT_LIST_OPTIONS,
} from '../lib/agentsList';
import {
  useAgentSessions,
  useAgentProjects,
  useSelectedSession,
} from '../lib/useAgentSessions';

// The Agents-mode sidebar: the "Projects" list. A Project is a Site in the
// Agents working set; under it, one row per agent Session (a "workspace") —
// live or exited. A Site joins the working set when a Session is launched in
// it. Clicking a Session row opens it in the Agents pane; the hover "+" on a
// Project starts a new one there. The toolbar adds a Site to the working set
// (Add project) or starts a Session in the current one (New workspace).
// Leaving Agents mode goes through the activity bar to its left
// (ActivityBar.jsx) or the back arrow (⌘[).
// Whether the sidebar shows the flat Activity list instead of the project
// tree. A per-viewer preference, so localStorage — guarded, since storage can
// be unavailable.
const ACTIVITY_VIEW_KEY = 'wpxen.agentsActivityView';
function readActivityView() {
  try {
    return localStorage.getItem(ACTIVITY_VIEW_KEY) === '1';
  } catch {
    return false;
  }
}
function writeActivityView(on) {
  try {
    localStorage.setItem(ACTIVITY_VIEW_KEY, on ? '1' : '0');
  } catch {
    // Storage unavailable — the choice just won't survive a reload.
  }
}

// Sort / filter / display choices from the Options menu, same storage rules.
const LIST_OPTIONS_KEY = 'wpxen.agentsListOptions';
function readListOptions() {
  try {
    return {
      ...DEFAULT_LIST_OPTIONS,
      ...JSON.parse(localStorage.getItem(LIST_OPTIONS_KEY) || '{}'),
    };
  } catch {
    return DEFAULT_LIST_OPTIONS;
  }
}
function writeListOptions(options) {
  try {
    localStorage.setItem(LIST_OPTIONS_KEY, JSON.stringify(options));
  } catch {
    // Storage unavailable — the choice just won't survive a reload.
  }
}

// The Options menu: radio groups for sorting and density, toggles for the
// filters. Each choice applies immediately; the menu stays open.
function OptionsMenu({ anchor, options, onChange, onClose }) {
  const item = (checked, label, patch) => (
    <button
      key={label}
      onClick={() => onChange({ ...options, ...patch })}
      className="w-full flex items-center gap-2 px-3 py-1 text-left text-[13px] text-foreground hover:bg-accent"
    >
      <span className="w-3.5 flex-shrink-0">{checked && <Check size={13} />}</span>
      {label}
    </button>
  );
  const radio = (key, value, label) =>
    item(options[key] === value, label, { [key]: value });
  const toggle = (key, label) => item(!!options[key], label, { [key]: !options[key] });
  const heading = (text) => (
    <div className="px-3 pt-1.5 pb-0.5 text-[11px] font-medium text-muted-foreground">
      {text}
    </div>
  );
  const rule = <div className="my-1 h-px bg-border" />;
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="panel fixed z-50 min-w-[220px] py-1"
        style={{ left: anchor.x, top: anchor.y }}
      >
        {heading('Sort projects')}
        {radio('projectSort', 'manual', 'Manual (drag to reorder)')}
        {radio('projectSort', 'recent', 'Recent activity')}
        {radio('projectSort', 'name', 'Name')}
        {rule}
        {heading('Sort sessions')}
        {radio('sessionSort', 'attention', 'Attention first')}
        {radio('sessionSort', 'launch', 'Launch order')}
        {rule}
        {heading('Filters')}
        {toggle('hideExited', 'Hide exited sessions')}
        {toggle('hideEmpty', 'Hide projects with no sessions')}
        {rule}
        {heading('Display')}
        {radio('display', 'detailed', 'Detailed')}
        {radio('display', 'compact', 'Compact')}
      </div>
    </>
  );
}

// Current time, re-read every `ms` so row ages ("4m") stay fresh.
function useNow(ms) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

// A small hover action on a row (mark read, dismiss), kept from opening it.
function RowAction({ label, onClick, children }) {
  return (
    <Tooltip label={label}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        aria-label={label}
        className="hidden group-hover/row:flex p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
      >
        {children}
      </button>
    </Tooltip>
  );
}

// One agent Session: status glyph, provider mark, title, and how long since
// its status last changed. Unread rows are bold. On hover the age gives way to
// a read/unread toggle, plus dismiss on an exited row.
export function SessionRow({ session: s, now, selected, onOpen, siteName, compact }) {
  const ended = s.state === 'exited' || s.state === 'error';
  return (
    <div
      onClick={onOpen}
      title={siteName ? `${siteName} · ${s.displayTitle}` : s.displayTitle}
      className={`group/row w-full min-w-0 flex items-center gap-1.5 pl-1.5 pr-1 ${
        compact ? 'py-[2px] text-[12.5px]' : 'py-[5px] text-[13px]'
      } rounded-md cursor-pointer ${
        selected
          ? 'bg-sidebar-accent text-sidebar-foreground'
          : 'text-sidebar-foreground/80 hover:bg-sidebar-accent'
      }`}
    >
      <AgentStatusGlyph state={s.state} />
      <ProviderIcon agentId={s.agentId} brand size={13} className="flex-shrink-0" />
      <span
        className={`truncate flex-1 ${
          s.unread
            ? 'font-semibold text-sidebar-foreground'
            : ended
              ? 'text-muted-foreground'
              : ''
        }`}
      >
        {s.displayTitle}
        {siteName && (
          <span className="font-normal text-muted-foreground"> · {siteName}</span>
        )}
      </span>
      {!compact && (
        <span className="text-[11px] text-muted-foreground tabular-nums flex-shrink-0 group-hover/row:hidden">
          {formatAge(now - s.changedAt)}
        </span>
      )}
      <RowAction
        label={s.unread ? 'Mark as read' : 'Mark as unread'}
        onClick={() => window.electronAPI.markSessionRead(s.sessionId, s.unread)}
      >
        {s.unread ? <BellOff size={12} /> : <Bell size={12} />}
      </RowAction>
      {ended && (
        <RowAction
          label="Dismiss"
          onClick={() => window.electronAPI.dismissSession(s.sessionId)}
        >
          <X size={12} />
        </RowAction>
      )}
    </div>
  );
}

export default function AgentsSidebar() {
  const navigate = useNavigate();
  const location = useLocation();

  // Active site parsed from the path (Layout renders this outside the matched
  // route, so useParams isn't available here).
  const m = location.pathname.match(/^\/agents\/([^/]+)/);
  const activeSite = m?.[1] ? decodeURIComponent(m[1]) : null;

  const sessions = useAgentSessions();
  const projectIds = useAgentProjects();
  const selected = useSelectedSession();
  const now = useNow(30_000);
  const [sites, setSites] = useState([]);
  const [branches, setBranches] = useState({}); // siteId -> branch | null
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [activityView, setActivityView] = useState(readActivityView);
  const [listOptions, setListOptions] = useState(readListOptions);
  const [optionsMenu, setOptionsMenu] = useState(null); // { x, y }
  const [dragging, setDragging] = useState(null); // siteId being dragged
  const updateListOptions = (next) => {
    setListOptions(next);
    writeListOptions(next);
  };
  const [launchMenu, setLaunchMenu] = useState(null); // { siteId, x, y }
  const [addMenu, setAddMenu] = useState(null); // { x, y } — Add project picker
  // New workspace menu; `siteId: null` shows the project list first.
  const [newMenu, setNewMenu] = useState(null); // { x, y, siteId }
  const [removing, setRemoving] = useState(null); // { site, live } pending confirm

  // Re-read sites when the working set changes — a newly added project may be
  // a site created since this mounted.
  const projectKey = projectIds.join('|');
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.getSites().then((s) => {
      if (!cancelled) setSites(s || []);
    });
    return () => {
      cancelled = true;
    };
  }, [projectKey]);

  const projects = useMemo(
    () => buildProjects({ projectIds, sites, sessions }),
    [projectIds, sites, sessions]
  );

  // Each project's checked-out branch. Refreshed as sessions come and go —
  // that's when an agent is most likely to have switched it.
  const sessionCount = sessions.length;
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      projects.map(async ({ site }) => [
        site.id,
        site.path ? await window.electronAPI.getGitBranch(site.path) : null,
      ])
    ).then((pairs) => {
      if (!cancelled) setBranches(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKey, sites, sessionCount]);

  const toggle = (id) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const openSession = (siteId, sessionId) =>
    navigate(`/agents/${encodeURIComponent(siteId)}`, {
      state: { focus: sessionId, nonce: Date.now() },
    });

  const launch = (siteId, agentId, targetId) => {
    setLaunchMenu(null);
    setNewMenu(null);
    navigate(`/agents/${encodeURIComponent(siteId)}`, {
      state: { spawn: agentId, target: targetId, nonce: Date.now() },
    });
  };

  const menuBelow = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: r.left, y: r.bottom + 4 };
  };

  const addProject = async (siteId) => {
    setAddMenu(null);
    await window.electronAPI.addAgentProject(siteId);
    navigate(`/agents/${encodeURIComponent(siteId)}`);
  };

  // Ask before ending running Sessions; a Project with none just goes.
  const requestRemove = (site, rows) => {
    const live = rows.filter((s) => !s.exited).length;
    if (live === 0) window.electronAPI.removeAgentProject(site.id);
    else setRemoving({ site, live });
  };

  const activity = activityView ? buildActivity(projects) : null;
  const shown = applyListOptions(projects, listOptions);
  const compact = listOptions.display === 'compact';
  const filters = activeFilterCount(listOptions);
  const canDrag = listOptions.projectSort === 'manual';

  // Manual order: move the dragged project into the slot of the one dropped on.
  const dropOn = (targetId) => {
    const from = dragging;
    setDragging(null);
    if (!from || from === targetId) return;
    const order = projectIds.filter((id) => id !== from);
    order.splice(projectIds.indexOf(targetId), 0, from);
    window.electronAPI.reorderAgentProjects(order);
  };
  const anyUnread = sessions.some((s) => s.unread);
  const toggleActivity = () => {
    setActivityView((v) => {
      writeActivityView(!v);
      return !v;
    });
  };

  const outside = sites.filter((s) => !projectIds.includes(s.id));
  // The "current" project for New workspace: the open Site, if it's one.
  const current = activeSite && projectIds.includes(activeSite) ? activeSite : null;

  return (
    <div className="flex-1 flex flex-col min-h-0 no-drag">
      <div className="flex items-center gap-0.5 pl-4 pr-3 pb-1">
        <span className="flex-1 text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
          {activityView ? 'Activity' : 'Projects'}
        </span>
        <Tooltip label={activityView ? 'Show projects' : 'Show activity'}>
          <button
            onClick={toggleActivity}
            aria-label={activityView ? 'Show projects' : 'Show activity'}
            aria-pressed={activityView}
            className={`relative p-1 rounded-md hover:bg-sidebar-accent ${
              activityView
                ? 'bg-highlight/15 text-highlight'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Bell size={14} />
            {anyUnread && (
              <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-status-warning ring-2 ring-sidebar" />
            )}
          </button>
        </Tooltip>
        {!activityView && (
          <Tooltip
            label={
              filters
                ? `Options — ${filters} filter${filters > 1 ? 's' : ''} on`
                : 'Options'
            }
          >
            <button
              onClick={(e) => {
                const pos = menuBelow(e);
                setOptionsMenu((m) => (m ? null : pos));
              }}
              aria-label="Options"
              className="relative p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-sidebar-accent"
            >
              <SlidersHorizontal size={14} />
              {filters > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[13px] h-[13px] px-[3px] rounded-full bg-highlight text-white text-[9px] font-semibold leading-[13px] text-center">
                  {filters}
                </span>
              )}
            </button>
          </Tooltip>
        )}
        {!activityView && (
          <Tooltip label="Add project">
            <button
              onClick={(e) => {
                // Refresh first: the picker must offer sites created since mount.
                window.electronAPI.getSites().then((s) => setSites(s || []));
                const pos = menuBelow(e);
                setAddMenu((m) => (m ? null : pos));
              }}
              aria-label="Add project"
              className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-sidebar-accent"
            >
              <FolderPlus size={14} />
            </button>
          </Tooltip>
        )}
        <Tooltip label="New workspace">
          <button
            onClick={(e) => {
              const pos = menuBelow(e);
              setNewMenu((m) => (m ? null : { ...pos, siteId: current }));
            }}
            aria-label="New workspace"
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-sidebar-accent"
          >
            <Plus size={15} />
          </button>
        </Tooltip>
      </div>

      {activity && (
        <nav className="flex-1 px-3 overflow-y-auto space-y-0.5">
          {activity.map((s) => (
            <SessionRow
              key={s.sessionId}
              session={s}
              siteName={s.siteName}
              compact={compact}
              now={now}
              selected={s.sessionId === selected}
              onOpen={() => openSession(s.siteId, s.sessionId)}
            />
          ))}
          {activity.length === 0 && (
            <p className="px-2 py-1 text-xs text-muted-foreground leading-relaxed">
              No agent sessions running.
            </p>
          )}
        </nav>
      )}

      <nav
        className={`flex-1 px-3 overflow-y-auto space-y-0.5 ${activity ? 'hidden' : ''}`}
      >
        {shown.map(({ site, sessions: rows }) => {
          const isOpen = !collapsed.has(site.id);
          // Collapsed, the project stands in for its sessions: their most
          // urgent glyph replaces the globe, and any unread makes it bold.
          const urgent = isOpen ? null : mostUrgent(rows);
          const anyUnread = !isOpen && rows.some((r) => r.unread);
          const branch = branches[site.id];
          return (
            <div
              key={site.id}
              onDragOver={(e) => {
                if (dragging) e.preventDefault();
              }}
              onDrop={() => dropOn(site.id)}
            >
              <div
                draggable={canDrag}
                onDragStart={() => setDragging(site.id)}
                onDragEnd={() => setDragging(null)}
                className={`group flex items-center gap-1.5 pl-2 pr-1 py-[5px] rounded-md text-[13px] hover:bg-sidebar-accent cursor-pointer ${
                  dragging === site.id ? 'opacity-50' : ''
                } ${
                  site.id === activeSite
                    ? 'text-sidebar-foreground'
                    : 'text-sidebar-foreground/90'
                }`}
                onClick={() => toggle(site.id)}
              >
                {isOpen ? (
                  <ChevronDown
                    size={14}
                    className="text-muted-foreground flex-shrink-0"
                  />
                ) : (
                  <ChevronRight
                    size={14}
                    className="text-muted-foreground flex-shrink-0"
                  />
                )}
                {urgent && urgent !== 'idle' ? (
                  <AgentStatusGlyph state={urgent} />
                ) : (
                  <Globe size={13} className="text-muted-foreground flex-shrink-0" />
                )}
                <span className={`truncate ${anyUnread ? 'font-bold' : 'font-medium'}`}>
                  {site.name}
                </span>
                <span className="flex-1" />
                {branch && !compact && (
                  <span
                    className="flex items-center gap-0.5 min-w-0 max-w-[45%] text-[11px] text-muted-foreground group-hover:hidden"
                    title={branch}
                  >
                    <GitBranch size={11} className="flex-shrink-0" />
                    <span className="truncate">{branch}</span>
                  </span>
                )}
                <Tooltip label="Remove from projects">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      requestRemove(site, rows);
                    }}
                    aria-label={`Remove ${site.name} from projects`}
                    className="hidden group-hover:flex p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
                  >
                    <FolderMinus size={13} />
                  </button>
                </Tooltip>
                <Tooltip label="New session">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setLaunchMenu({ siteId: site.id, ...menuBelow(e) });
                    }}
                    aria-label={`New session in ${site.name}`}
                    className="hidden group-hover:flex p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
                  >
                    <Plus size={14} />
                  </button>
                </Tooltip>
              </div>

              {isOpen && (
                <div className="ml-[18px] mt-0.5 space-y-0.5 border-l border-sidebar-border pl-2">
                  {rows.map((s) => (
                    <SessionRow
                      key={s.sessionId}
                      session={s}
                      compact={compact}
                      now={now}
                      selected={s.sessionId === selected}
                      onOpen={() => openSession(site.id, s.sessionId)}
                    />
                  ))}
                  {rows.length === 0 && (
                    <p className="px-2 py-1 text-xs text-muted-foreground">
                      No sessions.
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {projects.length === 0 && (
          <p className="px-2 py-1 text-xs text-muted-foreground leading-relaxed">
            No projects yet. Use Add project to pick a site to work on with agents.
          </p>
        )}
        {projects.length > 0 && shown.length === 0 && (
          <p className="px-2 py-1 text-xs text-muted-foreground leading-relaxed">
            Every project is hidden by a filter. Check Options.
          </p>
        )}
      </nav>

      {launchMenu && (
        <LaunchMenu
          siteId={launchMenu.siteId}
          anchor={launchMenu}
          onClose={() => setLaunchMenu(null)}
          onLaunch={(agentId, targetId) => launch(launchMenu.siteId, agentId, targetId)}
        />
      )}

      {optionsMenu && (
        <OptionsMenu
          anchor={optionsMenu}
          options={listOptions}
          onChange={updateListOptions}
          onClose={() => setOptionsMenu(null)}
        />
      )}

      {addMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setAddMenu(null)} />
          <div
            className="panel fixed z-50 min-w-[200px] max-w-[280px] max-h-[60vh] overflow-y-auto py-1"
            style={{ left: addMenu.x, top: addMenu.y }}
          >
            {outside.map((site) => (
              <button
                key={site.id}
                onClick={() => addProject(site.id)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-foreground hover:bg-accent"
              >
                <Globe size={14} className="flex-shrink-0 text-muted-foreground" />
                <span className="truncate">{site.name}</span>
              </button>
            ))}
            {outside.length === 0 && (
              <p className="px-3 py-1.5 text-[12px] text-muted-foreground">
                Every site is already a project.
              </p>
            )}
            <div className="my-1 h-px bg-border" />
            <button
              onClick={() => {
                setAddMenu(null);
                navigate('/sites', { state: { addForAgents: true } });
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Plus size={14} />
              Create new site…
            </button>
          </div>
        </>
      )}

      {newMenu && newMenu.siteId && (
        <LaunchMenu
          key={newMenu.siteId}
          siteId={newMenu.siteId}
          anchor={newMenu}
          onClose={() => setNewMenu(null)}
          onLaunch={(agentId, targetId) => launch(newMenu.siteId, agentId, targetId)}
          header={
            <div className="px-3 pt-1 pb-1.5 text-[11px] font-medium text-muted-foreground truncate">
              {sites.find((s) => s.id === newMenu.siteId)?.name}
            </div>
          }
          footer={
            projects.length > 1 && (
              <>
                <div className="my-1 h-px bg-border" />
                <button
                  onClick={() => setNewMenu((m) => ({ ...m, siteId: null }))}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <ChevronRight size={14} />
                  In another project…
                </button>
              </>
            )
          }
        />
      )}

      {newMenu && !newMenu.siteId && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setNewMenu(null)} />
          <div
            className="panel fixed z-50 min-w-[200px] max-w-[280px] max-h-[60vh] overflow-y-auto py-1"
            style={{ left: newMenu.x, top: newMenu.y }}
          >
            {current && (
              <>
                <button
                  onClick={() => setNewMenu((m) => ({ ...m, siteId: current }))}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <ChevronLeft size={14} />
                  Back
                </button>
                <div className="my-1 h-px bg-border" />
              </>
            )}
            {projects.map(({ site }) => (
              <button
                key={site.id}
                onClick={() => setNewMenu((m) => ({ ...m, siteId: site.id }))}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-foreground hover:bg-accent"
              >
                <Globe size={14} className="flex-shrink-0 text-muted-foreground" />
                <span className="truncate flex-1">{site.name}</span>
                <ChevronRight size={13} className="text-muted-foreground" />
              </button>
            ))}
            {projects.length === 0 && (
              <p className="px-3 py-1.5 text-[12px] text-muted-foreground">
                Add a project first.
              </p>
            )}
          </div>
        </>
      )}

      <ConfirmDialog
        open={removing != null}
        title="Remove project?"
        description={
          removing
            ? `End ${removing.live} running session${removing.live === 1 ? '' : 's'} in ${
                removing.site.name
              } and remove it from Projects? The site itself is not deleted.`
            : ''
        }
        confirmLabel="End & Remove"
        danger
        onConfirm={() => {
          window.electronAPI.removeAgentProject(removing.site.id);
          setRemoving(null);
        }}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}
