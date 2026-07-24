import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ChevronDown, Globe, Terminal } from 'lucide-react';

// The Agents-mode sidebar: a back button over a Sites tree. Each Site collapses
// to its available providers (Agents); clicking one opens that Agent's terminal
// in the selected Site's directory (route /agents/<siteId>/<agentId>).
export default function AgentsSidebar({ onBack }) {
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
      setAgents(a || []);
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
      <div className="px-3 pb-2">
        <button
          onClick={onBack}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[13px] text-gray-700 hover:text-gray-900 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
        >
          <ChevronLeft size={15} strokeWidth={2.4} />
          Menu
        </button>
      </div>

      <div className="px-4 pb-1 text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
        Sites
      </div>

      <nav className="flex-1 px-3 overflow-y-auto space-y-0.5">
        {sites.map((site) => {
          const isOpen = expanded.has(site.id);
          return (
            <div key={site.id}>
              <button
                onClick={() => toggle(site.id)}
                className="w-full flex items-center gap-1.5 px-2 py-[5px] rounded-md text-[13px] text-gray-800 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
              >
                {isOpen ? (
                  <ChevronDown size={14} className="text-gray-500 flex-shrink-0" />
                ) : (
                  <ChevronRight size={14} className="text-gray-500 flex-shrink-0" />
                )}
                <Globe size={13} className="text-gray-500 flex-shrink-0" />
                <span className="truncate flex-1 text-left">{site.name}</span>
              </button>

              {isOpen && (
                <div className="ml-[18px] mt-0.5 space-y-0.5 border-l border-black/[0.06] dark:border-white/[0.08] pl-2">
                  {agents.map((agent) => {
                    // Each click spawns a NEW Session (many per Site allowed);
                    // the pane reads spawn+nonce from navigation state.
                    return (
                      <button
                        key={agent.id}
                        disabled={!agent.detected}
                        title={
                          agent.detected
                            ? 'Open a new session'
                            : `Not installed · ${agent.install}`
                        }
                        onClick={() =>
                          navigate(`/agents/${encodeURIComponent(site.id)}`, {
                            state: { spawn: agent.id, nonce: Date.now() },
                          })
                        }
                        className={`w-full flex items-center gap-1.5 px-2 py-[5px] rounded-md text-[13px] ${
                          agent.detected
                            ? 'text-gray-700 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]'
                            : 'text-gray-400 cursor-not-allowed'
                        }`}
                      >
                        <Terminal size={12} strokeWidth={2.2} className="flex-shrink-0" />
                        <span className="truncate">{agent.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {sites.length === 0 && (
          <p className="px-2 py-1 text-xs text-gray-500">No sites yet.</p>
        )}
      </nav>
    </div>
  );
}
