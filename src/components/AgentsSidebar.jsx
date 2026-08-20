import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ChevronRight, ChevronDown, Globe, Download, Loader } from 'lucide-react';
import { ProviderIcon } from './providerIcons';
import { useAgentInstall } from '../lib/useAgentInstall';
import { installerTooltip } from '../lib/installerLabel';

// The Agents-mode sidebar: a Sites tree. Each Site collapses to its available
// providers (Agents); clicking one opens that Agent's terminal in the selected
// Site's directory (route /agents/<siteId>/<agentId>). Leaving Agents mode goes
// through the window-control back arrow (⌘[), same as anywhere else.
export default function AgentsSidebar() {
  const navigate = useNavigate();
  const location = useLocation();

  // Active site parsed from the path (Layout renders this outside the matched
  // route, so useParams isn't available here).
  const m = location.pathname.match(/^\/agents\/([^/]+)/);
  const activeSite = m?.[1] ? decodeURIComponent(m[1]) : null;

  const [sites, setSites] = useState([]);
  const [agents, setAgents] = useState([]);
  const [expanded, setExpanded] = useState(() => new Set());

  const refreshAgents = useCallback(() => {
    window.electronAPI
      .listAgents()
      .then((a) => setAgents(a || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    (async () => {
      const [s, a] = await Promise.all([
        window.electronAPI.getSites(),
        window.electronAPI.listAgents(),
      ]);
      setSites(s || []);
      setAgents(a || []);
    })();
  }, []);

  // An install here re-probes detection, so the row it was offered on turns
  // into a launchable agent without a reload.
  const { installing, logLine, result, install } = useAgentInstall({
    onInstalled: refreshAgents,
  });

  // Keep the selected Site expanded.
  useEffect(() => {
    if (activeSite) setExpanded((prev) => new Set(prev).add(activeSite));
  }, [activeSite]);

  const toggle = (id) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="flex-1 flex flex-col min-h-0 no-drag">
      <div className="px-4 pb-1 text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
        Sites
      </div>

      <nav className="flex-1 px-3 overflow-y-auto space-y-0.5">
        {sites.map((site) => {
          const isOpen = expanded.has(site.id);
          return (
            <div key={site.id}>
              <button
                onClick={() => toggle(site.id)}
                className="w-full flex items-center gap-1.5 px-2 py-[5px] rounded-md text-[13px] text-sidebar-foreground/90 hover:bg-sidebar-accent"
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
                <span className="truncate flex-1 text-left">{site.name}</span>
              </button>

              {isOpen && (
                <div className="ml-[18px] mt-0.5 space-y-0.5 border-l border-sidebar-border pl-2">
                  {agents.map((agent) => {
                    // Each click spawns a NEW Session (many per Site allowed);
                    // the pane reads spawn+nonce from navigation state.
                    const isInstalling = installing === agent.id;
                    // The install affordance rides on the row rather than
                    // replacing it: the row stays the launcher, and the icon
                    // is the way out of a dead one. Only agents with a vetted
                    // Homebrew package get it — the rest keep the tooltip.
                    const canInstall = !agent.detected && !!agent.installer;
                    const failed =
                      result?.agentId === agent.id && result.type === 'error';

                    return (
                      <div
                        key={agent.id}
                        className={`group flex items-center rounded-md ${
                          agent.detected ? 'hover:bg-sidebar-accent' : ''
                        }`}
                      >
                        <button
                          disabled={!agent.detected}
                          title={
                            agent.isShell
                              ? 'Open a shell in this site’s folder'
                              : agent.detected
                                ? 'Open a new session'
                                : isInstalling
                                  ? logLine || 'Installing…'
                                  : failed
                                    ? result.text
                                    : `Not installed · ${agent.install}`
                          }
                          onClick={() =>
                            navigate(`/agents/${encodeURIComponent(site.id)}`, {
                              state: { spawn: agent.id, nonce: Date.now() },
                            })
                          }
                          className={`flex-1 min-w-0 flex items-center gap-1.5 px-2 py-[5px] rounded-md text-[13px] ${
                            agent.detected
                              ? 'text-sidebar-foreground/80'
                              : 'text-muted-foreground/60 cursor-not-allowed'
                          }`}
                        >
                          <ProviderIcon
                            agentId={agent.id}
                            brand={agent.detected}
                            size={13}
                            className="flex-shrink-0"
                          />
                          <span className="truncate">{agent.name}</span>
                        </button>

                        {canInstall && (
                          <button
                            onClick={() => install(agent)}
                            disabled={!!installing}
                            aria-label={`Install ${agent.name} — ${installerTooltip(agent.installer)}`}
                            title={
                              isInstalling
                                ? logLine || 'Installing…'
                                : installerTooltip(agent.installer)
                            }
                            className={`flex-shrink-0 mr-1 p-1 rounded-md text-muted-foreground/70 hover:text-foreground hover:bg-sidebar-accent disabled:cursor-not-allowed ${
                              // Stays put while installing or after a failure;
                              // otherwise it's hover/focus-revealed so the tree
                              // doesn't read as a wall of buttons.
                              isInstalling || failed
                                ? 'opacity-100'
                                : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                            } ${failed ? 'text-destructive' : ''}`}
                          >
                            {isInstalling ? (
                              <Loader size={12} className="animate-spin" />
                            ) : (
                              <Download size={12} />
                            )}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {sites.length === 0 && (
          <p className="px-2 py-1 text-xs text-muted-foreground">No sites yet.</p>
        )}
      </nav>
    </div>
  );
}
