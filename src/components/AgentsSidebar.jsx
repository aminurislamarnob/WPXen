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
} from 'lucide-react';
import { ProviderIcon } from './providerIcons';
import { Tooltip, ConfirmDialog } from './ui';
import LaunchMenu from './LaunchMenu';
import { buildProjects } from '../lib/agentsList';
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
  const [sites, setSites] = useState([]);
  const [branches, setBranches] = useState({}); // siteId -> branch | null
  const [collapsed, setCollapsed] = useState(() => new Set());
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

  const outside = sites.filter((s) => !projectIds.includes(s.id));
  // The "current" project for New workspace: the open Site, if it's one.
  const current = activeSite && projectIds.includes(activeSite) ? activeSite : null;

  return (
    <div className="flex-1 flex flex-col min-h-0 no-drag">
      <div className="flex items-center gap-0.5 pl-4 pr-3 pb-1">
        <span className="flex-1 text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
          Projects
        </span>
        <Tooltip label="Add project">
          <button
            onClick={(e) => {
              // Refresh first: the picker must offer sites created since mount.
              window.electronAPI.getSites().then((s) => setSites(s || []));
              setAddMenu((m) => (m ? null : menuBelow(e)));
            }}
            aria-label="Add project"
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-sidebar-accent"
          >
            <FolderPlus size={14} />
          </button>
        </Tooltip>
        <Tooltip label="New workspace">
          <button
            onClick={(e) =>
              setNewMenu((m) => (m ? null : { ...menuBelow(e), siteId: current }))
            }
            aria-label="New workspace"
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-sidebar-accent"
          >
            <Plus size={15} />
          </button>
        </Tooltip>
      </div>

      <nav className="flex-1 px-3 overflow-y-auto space-y-0.5">
        {projects.map(({ site, sessions: rows }) => {
          const isOpen = !collapsed.has(site.id);
          const branch = branches[site.id];
          return (
            <div key={site.id}>
              <div
                className={`group flex items-center gap-1.5 pl-2 pr-1 py-[5px] rounded-md text-[13px] hover:bg-sidebar-accent cursor-pointer ${
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
                <Globe size={13} className="text-muted-foreground flex-shrink-0" />
                <span className="truncate font-medium">{site.name}</span>
                <span className="flex-1" />
                {branch && (
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
                    <div
                      key={s.sessionId}
                      onClick={() => openSession(site.id, s.sessionId)}
                      title={s.displayTitle}
                      className={`group/row w-full min-w-0 flex items-center gap-1.5 pl-2 pr-1 py-[5px] rounded-md text-[13px] cursor-pointer ${
                        s.sessionId === selected
                          ? 'bg-sidebar-accent text-sidebar-foreground'
                          : 'text-sidebar-foreground/80 hover:bg-sidebar-accent'
                      } ${s.exited ? 'opacity-60' : ''}`}
                    >
                      <ProviderIcon
                        agentId={s.agentId}
                        brand
                        size={13}
                        className="flex-shrink-0"
                      />
                      <span className="truncate flex-1">{s.displayTitle}</span>
                      {s.exited && (
                        <Tooltip label="Dismiss">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              window.electronAPI.dismissSession(s.sessionId);
                            }}
                            aria-label="Dismiss session"
                            className="hidden group-hover/row:flex p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
                          >
                            <X size={12} />
                          </button>
                        </Tooltip>
                      )}
                    </div>
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
      </nav>

      {launchMenu && (
        <LaunchMenu
          siteId={launchMenu.siteId}
          anchor={launchMenu}
          onClose={() => setLaunchMenu(null)}
          onLaunch={(agentId, targetId) => launch(launchMenu.siteId, agentId, targetId)}
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
