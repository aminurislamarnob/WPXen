import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useLocation, useOutletContext } from 'react-router-dom';
import {
  Terminal as TerminalIcon,
  Plus,
  X,
  Settings2,
  CornerDownRight,
  Globe,
  Gauge,
  Database,
  Mail,
  Loader2,
} from 'lucide-react';
import { ProviderIcon } from './providerIcons';
import { Panel, PanelGroup } from 'react-resizable-panels';
import Terminal from './Terminal';
import FileExplorer from './FileExplorer';
import CodeEditor from './CodeEditor';
import ResizeHandle from './ResizeHandle';
import LaunchTargetsDialog from './LaunchTargetsDialog';
import { ConfirmDialog, Tooltip } from './ui';
import * as sessionCache from '../lib/terminal/sessionCache';
import * as webviewCache from '../lib/browser/webviewCache';

// Strip a leading emoji/symbol + space from an OSC title (agents like Claude
// Code prefix a status glyph) so the tab label reads cleanly.
const cleanTitle = (t) => t.trim().replace(/^[\p{Emoji}\p{Symbol}]\s*/u, '');

const CLOSE_CONFIRM_KEY = 'wpherd.terminalCloseConfirmSuppressed';

// The places you actually want to look at while an agent works on a site.
// Order is by how often they're reached for, not alphabetical.
const BROWSER_TARGETS = [
  { id: 'site', label: 'Site', icon: Globe },
  { id: 'wp-admin', label: 'WP Admin', icon: Gauge },
  { id: 'phpmyadmin', label: 'phpMyAdmin', icon: Database },
  { id: 'mailpit', label: 'Mail inbox', icon: Mail },
];

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
  const [targets, setTargets] = useState([]); // saved Launch Targets for this Site
  const [settingsOpen, setSettingsOpen] = useState(false); // launch-settings dialog
  const [error, setError] = useState(null);

  const [tabs, setTabs] = useState([]); // [{ sessionId, agentId, agentName }]
  const [activeTab, setActiveTab] = useState(null); // sessionId
  const [addMenu, setAddMenu] = useState(null); // { x, y } when the + menu is open
  const [browserMenu, setBrowserMenu] = useState(null); // { x, y } for the browser targets
  const [browserBusy, setBrowserBusy] = useState(null); // target id being resolved

  const [openFiles, setOpenFiles] = useState([]); // editor tabs [{ key, kind, ... }]
  const [activeKey, setActiveKey] = useState(null);
  // Per-browser-tab chrome state, fed by the webview's own events. The pages
  // themselves live in webviewCache, not here.
  const [browserState, setBrowserState] = useState({}); // key -> {url,title,loading,error}
  const browserSeq = useRef(0);
  const [titles, setTitles] = useState({}); // sessionId -> OSC title
  const [closeConfirm, setCloseConfirm] = useState(null); // sessionId pending confirm
  const [suppressClose, setSuppressClose] = useState(false); // checkbox in dialog

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
      const [sites, agentList, targetList] = await Promise.all([
        window.electronAPI.getSites(),
        window.electronAPI.listAgents(),
        window.electronAPI.listLaunchTargets(siteId),
      ]);
      if (cancelled) return;
      const site = (sites || []).find((s) => s.id === siteId);
      // url/dbName feed the browser target menu; keep them alongside the name.
      setMeta({
        siteName: site?.name || siteId,
        url: site?.url || null,
        dbName: site?.dbName || null,
      });
      setSitePath(site?.path || null);
      setAgents(agentList || []);
      setTargets(targetList || []);

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

  // Drop editor tabs when the Site changes. Browser tabs are site-scoped too,
  // and their webviews would otherwise stay parked off-screen forever.
  useEffect(() => {
    webviewCache.disposeAll();
    setBrowserState({});
    setOpenFiles([]);
    setActiveKey(null);
  }, [siteId]);

  // Same on unmount — leaving the Agents screen must not leak live pages.
  useEffect(() => () => webviewCache.disposeAll(), []);

  // Open the "+" menu anchored just below the button, in viewport coordinates.
  const openAddMenu = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    setAddMenu((m) => (m ? null : { x: r.left, y: r.bottom + 4 }));
  };

  const spawn = async (agentId, targetId = null) => {
    setAddMenu(null);
    const res = await window.electronAPI.launchAgent(siteId, agentId, targetId);
    if (res?.error) return setError(res.error);
    if (!res?.sessionId) return;
    const name = agents.find((a) => a.id === agentId)?.name || agentId;
    const label = targetId ? targets.find((t) => t.id === targetId)?.label || null : null;
    setTabs((prev) => [
      ...prev,
      { sessionId: res.sessionId, agentId, agentName: name, targetId, label },
    ]);
    setActiveTab(res.sessionId);
  };

  // Actually tear the Session down: stop the pty, dispose the cached xterm,
  // drop the tab.
  const destroyTab = async (sessionId) => {
    await window.electronAPI.terminalStop(sessionId);
    sessionCache.dispose(sessionId);
    setTitles((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.sessionId === sessionId);
      const next = prev.filter((t) => t.sessionId !== sessionId);
      if (activeTab === sessionId) {
        setActiveTab((next[idx] || next[idx - 1])?.sessionId || null);
      }
      return next;
    });
  };

  // Close request from the tab's X: confirm first if the session is still
  // running and the user hasn't suppressed the prompt. An already-exited
  // session closes without asking.
  const closeTab = (sessionId) => {
    if (
      sessionCache.isExited(sessionId) ||
      localStorage.getItem(CLOSE_CONFIRM_KEY) === '1'
    ) {
      return destroyTab(sessionId);
    }
    setSuppressClose(false);
    setCloseConfirm(sessionId);
  };

  const confirmClose = () => {
    if (suppressClose) localStorage.setItem(CLOSE_CONFIRM_KEY, '1');
    const id = closeConfirm;
    setCloseConfirm(null);
    destroyTab(id);
  };

  // Respawn the same Agent in place after its shell exited: reap the dead
  // session, launch a fresh one, and swap it into the same tab position.
  const respawn = async (sessionId) => {
    const tab = tabs.find((t) => t.sessionId === sessionId);
    if (!tab) return;
    const res = await window.electronAPI.launchAgent(siteId, tab.agentId, tab.targetId);
    if (res?.error) return setError(res.error);
    if (!res?.sessionId) return;
    window.electronAPI.terminalStop(sessionId);
    sessionCache.dispose(sessionId);
    setTabs((prev) =>
      prev.map((t) =>
        t.sessionId === sessionId ? { ...t, sessionId: res.sessionId } : t
      )
    );
    setActiveTab(res.sessionId);
  };

  // Stable per-render callbacks passed into the cached terminal handlers.
  const handleTitle = useCallback((sessionId, title) => {
    const cleaned = cleanTitle(title);
    if (cleaned) setTitles((prev) => ({ ...prev, [sessionId]: cleaned }));
  }, []);

  // A file-path link Cmd+clicked in terminal output → open/focus an editor tab
  // at the given line.
  const openFileAtLine = useCallback((resolved, line, _col, isDir) => {
    if (isDir) return; // directories aren't editable; ignore
    const name = resolved.split('/').pop() || resolved;
    setOpenFiles((prev) => {
      const existing = prev.find((f) => f.key === resolved);
      if (existing) {
        return prev.map((f) => (f.key === resolved ? { ...f, line } : f));
      }
      return [...prev, { key: resolved, kind: 'file', path: resolved, name, line }];
    });
    setActiveKey(resolved);
  }, []);

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
  // the file's editable tab (and with the same rel in a different repo/source).
  const openDiff = (entry) => {
    const key = `diff:${entry.repoRoot}:${entry.source}:${entry.rel}`;
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
              repoRoot: entry.repoRoot,
              source: entry.source,
              status: entry.status,
              hasStagedTwin: entry.hasStagedTwin,
            },
          ]
    );
    setActiveKey(key);
  };

  // Open a browser tab in the editor column. Keys are sequential rather than
  // URL-derived so the same URL can be open twice, and so navigating away from
  // the initial URL doesn't orphan the webview in its cache.
  const openBrowser = useCallback((url = 'about:blank') => {
    const key = `browser:${++browserSeq.current}`;
    setBrowserState((prev) => ({
      ...prev,
      [key]: { url, title: '', loading: true, error: null },
    }));
    setOpenFiles((prev) => [...prev, { key, kind: 'browser', name: 'Browser', url }]);
    setActiveKey(key);
  }, []);

  // Resolve one of the site's well-known targets and open it in a browser tab.
  // The service-backed ones (phpMyAdmin, Mailpit) install and configure
  // themselves on first use, so they're async and can fail — hence the busy
  // marker on the menu item and the shared error line below the tab strip.
  const openBrowserTarget = async (target) => {
    setError(null);
    if (target === 'blank') {
      setBrowserMenu(null);
      return openBrowser();
    }
    if (target === 'site') {
      setBrowserMenu(null);
      if (!meta.url) return setError('This site has no URL yet.');
      return openBrowser(meta.url);
    }

    setBrowserBusy(target);
    let res;
    if (target === 'wp-admin') {
      res = await window.electronAPI.getWpAdminUrl(siteId);
    } else if (target === 'phpmyadmin') {
      if (!meta.dbName) {
        setBrowserBusy(null);
        return setError('This site has no database.');
      }
      res = await window.electronAPI.getPhpMyAdminUrl(meta.dbName);
    } else {
      res = await window.electronAPI.getMailpitUrl();
    }
    setBrowserBusy(null);
    setBrowserMenu(null);
    if (!res?.success) return setError(res?.error || 'Could not open that target.');
    openBrowser(res.url);
  };

  // Stable across renders — the cached webview holds onto this via a ref.
  const onBrowserStateChange = useCallback((key, patch) => {
    setBrowserState((prev) =>
      prev[key] ? { ...prev, [key]: { ...prev[key], ...patch } } : prev
    );
  }, []);

  const closeFile = (key) => {
    // A browser tab's page outlives its React component by design, so closing
    // the tab is the one moment it has to be torn down for real.
    if (key.startsWith('browser:')) {
      webviewCache.dispose(key);
      setBrowserState((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
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
        <p className="text-[15px] font-semibold text-foreground">Agents</p>
        <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">
          Pick a site in the sidebar, expand it, and choose an AI agent to open it in that
          site&rsquo;s directory.
        </p>
      </div>
    );
  }

  const editorOpen = openFiles.length > 0;
  const detected = agents.filter((a) => a.detected);
  // The active editor tab, when it's a real file (not a diff) — drives the
  // "reveal in tree" behavior in the explorer.
  const activeTabEntry = openFiles.find((f) => f.key === activeKey) || null;
  const activeFileTab = activeTabEntry?.kind === 'file' ? activeTabEntry : null;
  // Ordinal suffix for duplicate providers, so identical tabs are tellable apart.
  const ordinal = (tab, i) => {
    const sameBefore = tabs.slice(0, i).filter((t) => t.agentId === tab.agentId).length;
    const total = tabs.filter((t) => t.agentId === tab.agentId).length;
    return total > 1 ? ` ${sameBefore + 1}` : '';
  };

  return (
    <>
      <PanelGroup
        direction="horizontal"
        autoSaveId={editorOpen ? 'agents-3pane' : 'agents-2pane'}
        className="h-full"
      >
        {/* Project explorer */}
        {sitePath && (
          <>
            <Panel id="explorer" order={1} defaultSize={20} minSize={12}>
              <div className="h-full border-r border-border">
                <FileExplorer
                  rootPath={sitePath}
                  rootName={meta.siteName}
                  onOpenFile={openFile}
                  onOpenDiff={openDiff}
                  insetForControls={sidebarCollapsed}
                  activeFilePath={activeFileTab?.path}
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
                        ? 'bg-muted text-foreground font-medium'
                        : 'text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    <ProviderIcon
                      agentId={tab.agentId}
                      brand
                      size={13}
                      className="flex-shrink-0"
                    />
                    <span className="truncate max-w-[140px]">
                      {titles[tab.sessionId] ||
                        tab.label ||
                        `${tab.agentName}${ordinal(tab, i)}`}
                    </span>
                    <Tooltip label="Close session">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTab(tab.sessionId);
                        }}
                        aria-label="Close session"
                        className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                      >
                        <X size={12} />
                      </button>
                    </Tooltip>
                  </div>
                );
              })}

              {/* Add-session button. The menu is rendered fixed (below) so the
                tab strip's overflow-x-auto can't clip it. */}
              <Tooltip label="New session">
                <button
                  onClick={openAddMenu}
                  disabled={detected.length === 0}
                  aria-label="New session"
                  className="flex-shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40"
                >
                  <Plus size={16} />
                </button>
              </Tooltip>
              <Tooltip label="Launch settings">
                <button
                  onClick={() => setSettingsOpen(true)}
                  disabled={detected.length === 0}
                  aria-label="Launch settings"
                  className="flex-shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40"
                >
                  <Settings2 size={15} />
                </button>
              </Tooltip>
              <div className="flex-1" />
              <Tooltip label="Open browser">
                <button
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setBrowserMenu((m) => (m ? null : { x: r.right - 220, y: r.bottom + 4 }));
                  }}
                  aria-label="Open browser"
                  className="flex-shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
                >
                  <Globe size={15} />
                </button>
              </Tooltip>
            </div>

            {browserMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setBrowserMenu(null)} />
                <div
                  className="panel fixed z-50 min-w-[220px] py-1"
                  style={{ left: browserMenu.x, top: browserMenu.y }}
                >
                  {BROWSER_TARGETS.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => openBrowserTarget(t.id)}
                      disabled={browserBusy != null}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-foreground hover:bg-accent disabled:opacity-50"
                    >
                      {browserBusy === t.id ? (
                        <Loader2 size={14} className="animate-spin flex-shrink-0" />
                      ) : (
                        <t.icon size={14} className="flex-shrink-0 text-muted-foreground" />
                      )}
                      {t.label}
                    </button>
                  ))}
                  <div className="my-1 h-px bg-border" />
                  <button
                    onClick={() => openBrowserTarget('blank')}
                    disabled={browserBusy != null}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                  >
                    <Plus size={14} className="flex-shrink-0" />
                    Blank tab
                  </button>
                </div>
              </>
            )}

            {addMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setAddMenu(null)} />
                <div
                  className="panel fixed z-50 min-w-[200px] max-w-[280px] py-1"
                  style={{ left: addMenu.x, top: addMenu.y }}
                >
                  {detected.map((a) => {
                    const agentTargets = targets.filter((t) => t.agentId === a.id);
                    return (
                      <div key={a.id}>
                        {/* Default launch: webroot + the agent's global flags. */}
                        <button
                          onClick={() => spawn(a.id)}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-foreground hover:bg-accent"
                        >
                          <ProviderIcon agentId={a.id} brand size={14} />
                          {a.name}
                        </button>
                        {/* Saved targets: a pinned directory (+ optional flags). */}
                        {agentTargets.map((t) => (
                          <button
                            key={t.id}
                            onClick={() => spawn(a.id, t.id)}
                            title={t.cwd}
                            className="w-full flex items-center gap-1.5 pl-7 pr-3 py-1 text-left text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
                          >
                            <CornerDownRight size={11} className="flex-shrink-0" />
                            <span className="truncate">{t.label || t.cwd}</span>
                          </button>
                        ))}
                      </div>
                    );
                  })}
                  <div className="my-1 h-px bg-border" />
                  <button
                    onClick={() => {
                      setAddMenu(null);
                      setSettingsOpen(true);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <Settings2 size={14} />
                    Launch settings…
                  </button>
                </div>
              </>
            )}

            {error && (
              <div className="px-3 py-1 text-[12px] text-destructive">{error}</div>
            )}

            {/* Active terminal. Only the active tab is mounted, but its xterm
              lives in sessionCache and is re-parented on mount — so switching
              tabs keeps scroll, selection and background output instead of
              replaying the ring buffer. */}
            <div className="flex-1 min-h-0 px-4 pb-4">
              {activeTab ? (
                <Terminal
                  key={activeTab}
                  sessionId={activeTab}
                  rootPath={sitePath}
                  onOpenFile={openFileAtLine}
                  onTitle={handleTitle}
                  onExited={() => destroyTab(activeTab)}
                  onRestart={() => respawn(activeTab)}
                />
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-center">
                  <p className="text-[13px] text-muted-foreground">
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
                          <ProviderIcon agentId={a.id} brand size={14} />
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
              <div className="h-full min-w-0 border-l border-border">
                <CodeEditor
                  rootPath={sitePath}
                  files={openFiles}
                  activeKey={activeKey}
                  onSelect={setActiveKey}
                  onClose={closeFile}
                  browserState={browserState}
                  onBrowserStateChange={onBrowserStateChange}
                />
              </div>
            </Panel>
          </>
        )}
      </PanelGroup>
      <ConfirmDialog
        open={closeConfirm != null}
        title="End session?"
        description={`This will terminate the running agent in ${
          tabs.find((t) => t.sessionId === closeConfirm)?.agentName || 'this session'
        }. Anything it is doing will be interrupted.`}
        confirmLabel="End Session"
        danger
        onConfirm={confirmClose}
        onCancel={() => setCloseConfirm(null)}
      >
        <label className="mt-3 flex items-center gap-2 text-[12.5px] text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={suppressClose}
            onChange={(e) => setSuppressClose(e.target.checked)}
          />
          Don&rsquo;t ask again
        </label>
      </ConfirmDialog>
      <LaunchTargetsDialog
        open={settingsOpen}
        siteId={siteId}
        sitePath={sitePath}
        agents={detected}
        onClose={() => setSettingsOpen(false)}
        onChanged={() =>
          window.electronAPI.listLaunchTargets(siteId).then((t) => setTargets(t || []))
        }
      />
    </>
  );
}
