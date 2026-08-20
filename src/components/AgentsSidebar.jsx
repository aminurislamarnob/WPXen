import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ChevronRight, ChevronDown, Globe } from 'lucide-react';
import { ProviderIcon } from './providerIcons';

// The Agents-mode sidebar: a Sites tree. Each Site collapses to its available
// providers (Agents); clicking one opens that Agent's terminal in the selected
// Site's directory (route /agents/<siteId>/<agentId>). Leaving Agents mode goes
// through the window-control back arrow (⌘[), same as anywhere else.
//
// Only agents that are both enabled and actually installed appear here. The
// list repeats under every Site, so an uninstallable row costs one dead line
// per site rather than one overall — and every row here is a launcher, so a
// row that can't launch is noise. Settings → Agents is where the full set
// lives, with the install buttons; this tree is for getting to work.
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

  useEffect(() => {
    (async () => {
      const [s, a] = await Promise.all([
        window.electronAPI.getSites(),
        window.electronAPI.listAgents(),
      ]);
      setSites(s || []);
      // listAgents() already applies the enabled filter; `detected` is the
      // other half. The plain Terminal reports detected, so it survives this.
      setAgents((a || []).filter((agent) => agent.detected));
    })();
  }, []);

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
                  {/* Each click spawns a NEW Session (many per Site allowed);
                      the pane reads spawn+nonce from navigation state. */}
                  {agents.map((agent) => (
                    <button
                      key={agent.id}
                      title={
                        agent.isShell
                          ? 'Open a shell in this site’s folder'
                          : 'Open a new session'
                      }
                      onClick={() =>
                        navigate(`/agents/${encodeURIComponent(site.id)}`, {
                          state: { spawn: agent.id, nonce: Date.now() },
                        })
                      }
                      className="w-full min-w-0 flex items-center gap-1.5 px-2 py-[5px] rounded-md text-[13px] text-sidebar-foreground/80 hover:bg-sidebar-accent"
                    >
                      <ProviderIcon
                        agentId={agent.id}
                        brand
                        size={13}
                        className="flex-shrink-0"
                      />
                      <span className="truncate">{agent.name}</span>
                    </button>
                  ))}
                  {agents.length === 0 && (
                    <p className="px-2 py-1 text-xs text-muted-foreground">
                      No agents installed.
                    </p>
                  )}
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
