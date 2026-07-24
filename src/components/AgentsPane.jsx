import { useEffect, useState } from 'react';
import { useParams, useLocation, useOutletContext } from 'react-router-dom';
import { Terminal as TerminalIcon, Plus, X } from 'lucide-react';
import { Panel, PanelGroup } from 'react-resizable-panels';
import Terminal from './Terminal';
import FileExplorer from './FileExplorer';
import CodeEditor from './CodeEditor';
import ResizeHandle from './ResizeHandle';

// Main pane for the Agents section. A Site can host MANY concurrent Sessions
// (any mix of Agents, incl. several of the same provider); each is a terminal
// tab. The sidebar spawns a Session via navigation state; the "+" spawns more.
export default function AgentsPane() {
  const { siteId } = useParams();
  const location = useLocation();
  // When the sidebar is hidden the explorer sits under the floating window
  // controls; inset its tab bar so they don't overlap.
  const { sidebarCollapsed } = useOutletContext() || {};

  const [meta, setMeta] = useState({ siteName: siteId });
  const [sitePath, setSitePath] = useState(null);
  const [agents, setAgents] = useState([]); // registry, for the "+" menu
  const [error, setError] = useState(null);

  const [tabs, setTabs] = useState([]); // [{ sessionId, agentId, agentName }]
  const [activeTab, setActiveTab] = useState(null); // sessionId
  const [addMenu, setAddMenu] = useState(null); // { x, y } when the + menu is open

  const [openFiles, setOpenFiles] = useState([]); // editor tabs [{ key, kind, ... }]
  const [activeKey, setActiveKey] = useState(null);

  // Load the Site, its live Sessions (restore tabs), and honour a pending spawn
  // request carried in navigation state. Runs on Site change and on every
  // navigation (location.key changes even for same-path spawns).
  //
  // StrictMode double-invokes this effect; the `cancelled` early-bail (set
  // synchronously by the first run's cleanup, before any IPC resolves) means the
  // discarded run never launches, and the surviving run does the full
  // launch + list — so no session is double-spawned or orphaned.
  useEffect(() => {
    if (!siteId) return;
    let cancelled = false;
    setError(null);

    (async () => {
      const [sites, agentList] = await Promise.all([
        window.electronAPI.getSites(),
        window.electronAPI.listAgents(),
      ]);
      if (cancelled) return;
      const site = (sites || []).find((s) => s.id === siteId);
      setMeta({ siteName: site?.name || siteId });
      setSitePath(site?.path || null);
      setAgents(agentList || []);

      // Honour a pending spawn from the sidebar (create the Session first, so the
      // subsequent listSessions below includes it).
      const spawnAgent = location.state?.spawn;
      let preferActive = null;
      if (spawnAgent) {
        const res = await window.electronAPI.launchAgent(siteId, spawnAgent);
        if (cancelled) return;
        if (res?.error) setError(res.error);
        else preferActive = res?.sessionId || null;
      }

      const sessions = await window.electronAPI.listSessions(siteId);
      if (cancelled) return;
      setTabs(sessions);
      setActiveTab(preferActive || sessions[0]?.sessionId || null);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, location.key]);

  // Drop editor tabs when the Site changes.
  useEffect(() => {
    setOpenFiles([]);
    setActiveKey(null);
  }, [siteId]);

  // Open the "+" menu anchored just below the button, in viewport coordinates.
  const openAddMenu = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    setAddMenu((m) => (m ? null : { x: r.left, y: r.bottom + 4 }));
  };

  const spawn = async (agentId) => {
    setAddMenu(null);
    const res = await window.electronAPI.launchAgent(siteId, agentId);
    if (res?.error) return setError(res.error);
    if (!res?.sessionId) return;
    const name = agents.find((a) => a.id === agentId)?.name || agentId;
    setTabs((prev) => [...prev, { sessionId: res.sessionId, agentId, agentName: name }]);
    setActiveTab(res.sessionId);
  };

  const closeTab = async (sessionId) => {
    await window.electronAPI.terminalStop(sessionId);
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.sessionId === sessionId);
      const next = prev.filter((t) => t.sessionId !== sessionId);
      if (activeTab === sessionId) {
        setActiveTab((next[idx] || next[idx - 1])?.sessionId || null);
      }
      return next;
    });
  };

  // Open a plain (editable) file tab, keyed by its absolute path.
  const openFile = (entry) => {
    const key = entry.path;
    setOpenFiles((prev) =>
      prev.some((f) => f.key === key)
        ? prev
        : [...prev, { key, kind: 'file', path: entry.path, name: entry.name }]
    );
    setActiveKey(key);
  };

  // Open a read-only diff tab for a changed file, keyed so it can coexist with
  // the file's editable tab (and with the same file's other-source diff).
  const openDiff = (entry) => {
    const key = `diff:${entry.source}:${entry.rel}`;
    setOpenFiles((prev) =>
      prev.some((f) => f.key === key)
        ? prev
        : [
            ...prev,
            {
              key,
              kind: 'diff',
              path: entry.path,
              name: entry.name,
              rel: entry.rel,
              source: entry.source,
              status: entry.status,
              hasStagedTwin: entry.hasStagedTwin,
            },
          ]
    );
    setActiveKey(key);
  };

  const closeFile = (key) => {
    setOpenFiles((prev) => {
      const idx = prev.findIndex((f) => f.key === key);
      const next = prev.filter((f) => f.key !== key);
      if (activeKey === key) {
        setActiveKey((next[idx] || next[idx - 1])?.key || null);
      }
      return next;
    });
  };

  if (!siteId) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6">
        <div className="icon-tile w-12 h-12 bg-[#af52de] mb-4">
          <TerminalIcon size={24} strokeWidth={2} />
        </div>
        <p className="text-[15px] font-semibold text-gray-900">Agents</p>
        <p className="mt-1 max-w-sm text-[13px] text-gray-500">
          Pick a site in the sidebar, expand it, and choose an AI agent to open it
          in that site&rsquo;s directory.
        </p>
      </div>
    );
  }

  const editorOpen = openFiles.length > 0;
  const detected = agents.filter((a) => a.detected);
  // Ordinal suffix for duplicate providers, so identical tabs are tellable apart.
  const ordinal = (tab, i) => {
    const sameBefore = tabs
      .slice(0, i)
      .filter((t) => t.agentId === tab.agentId).length;
    const total = tabs.filter((t) => t.agentId === tab.agentId).length;
    return total > 1 ? ` ${sameBefore + 1}` : '';
  };

  return (
    <PanelGroup
      direction="horizontal"
      autoSaveId={editorOpen ? 'agents-3pane' : 'agents-2pane'}
      className="h-full"
    >
      {/* Project explorer */}
      {sitePath && (
        <>
          <Panel id="explorer" order={1} defaultSize={20} minSize={12}>
            <div className="h-full border-r border-black/[0.06] dark:border-white/[0.08]">
              <FileExplorer
                rootPath={sitePath}
                rootName={meta.siteName}
                onOpenFile={openFile}
                onOpenDiff={openDiff}
                insetForControls={sidebarCollapsed}
              />
            </div>
          </Panel>
          <ResizeHandle />
        </>
      )}

      {/* Terminal column: tab strip + active Session */}
      <Panel id="terminal" order={2} minSize={20} defaultSize={editorOpen ? 50 : 80}>
        <div className="h-full min-w-0 flex flex-col">
          {/* Tab strip */}
          <div className="flex items-center gap-1 px-2 h-10 flex-shrink-0 overflow-x-auto">
            {tabs.map((tab, i) => {
              const isActive = tab.sessionId === activeTab;
              return (
                <div
                  key={tab.sessionId}
                  onClick={() => setActiveTab(tab.sessionId)}
                  className={`group flex items-center gap-1.5 pl-2.5 pr-1.5 h-7 rounded-lg text-[12.5px] cursor-pointer whitespace-nowrap ${
                    isActive
                      ? 'bg-black/[0.06] dark:bg-white/[0.1] text-gray-900 font-medium'
                      : 'text-gray-500 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'
                  }`}
                >
                  <TerminalIcon size={12} strokeWidth={2.2} className="flex-shrink-0" />
                  <span className="truncate max-w-[140px]">
                    {tab.agentName}
                    {ordinal(tab, i)}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.sessionId);
                    }}
                    className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/15 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                    title="Close session"
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}

            {/* Add-session button. The menu is rendered fixed (below) so the
                tab strip's overflow-x-auto can't clip it. */}
            <button
              onClick={openAddMenu}
              disabled={detected.length === 0}
              className="flex-shrink-0 p-1 rounded-md text-gray-500 hover:text-gray-800 hover:bg-black/[0.05] dark:hover:text-gray-200 dark:hover:bg-white/[0.07] disabled:opacity-40"
              title="New session"
            >
              <Plus size={16} />
            </button>
          </div>

          {addMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setAddMenu(null)} />
              <div
                className="panel fixed z-50 min-w-[170px] py-1"
                style={{ left: addMenu.x, top: addMenu.y }}
              >
                {detected.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => spawn(a.id)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-gray-800 hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
                  >
                    <TerminalIcon size={13} strokeWidth={2.2} />
                    {a.name}
                  </button>
                ))}
              </div>
            </>
          )}

          {error && (
            <div className="px-3 py-1 text-[12px] text-red-600 dark:text-red-400">
              {error}
            </div>
          )}

          {/* Active terminal (only the active tab is mounted; switching remounts
              and replays that Session's ring buffer). */}
          <div className="flex-1 min-h-0 px-4 pb-4">
            {activeTab ? (
              <Terminal
                key={activeTab}
                sessionId={activeTab}
                onExited={() => closeTab(activeTab)}
              />
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-center">
                <p className="text-[13px] text-gray-500">
                  No sessions yet for {meta.siteName}.
                </p>
                {detected.length > 0 && (
                  <div className="mt-3 flex flex-wrap justify-center gap-2">
                    {detected.map((a) => (
                      <button
                        key={a.id}
                        className="btn btn-secondary"
                        onClick={() => spawn(a.id)}
                      >
                        <TerminalIcon size={12} strokeWidth={2.5} />
                        {a.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </Panel>

      {/* Code editor column */}
      {editorOpen && (
        <>
          <ResizeHandle />
          <Panel id="editor" order={3} minSize={20} defaultSize={30}>
            <div className="h-full min-w-0 border-l border-black/[0.06] dark:border-white/[0.08]">
              <CodeEditor
                rootPath={sitePath}
                files={openFiles}
                activeKey={activeKey}
                onSelect={setActiveKey}
                onClose={closeFile}
              />
            </div>
          </Panel>
        </>
      )}
    </PanelGroup>
  );
}
