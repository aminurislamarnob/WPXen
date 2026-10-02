import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useParams, useLocation, useNavigate, useOutletContext } from 'react-router-dom';
import {
  Terminal as TerminalIcon,
  Plus,
  X,
  Settings2,
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
import LaunchMenu from './LaunchMenu';
import { ConfirmDialog, Tooltip } from './ui';
import * as sessionCache from '../lib/terminal/sessionCache';
import * as webviewCache from '../lib/browser/webviewCache';
import { useSettings } from '../lib/useSettings';
import { LAST_AGENTS_SITE_KEY, resolveLastSite } from '../lib/activityBar';
import { sessionTitle } from '../lib/agentsList';
import { useAgentSessions, setSelectedSession } from '../lib/useAgentSessions';

const CLOSE_CONFIRM_KEY = 'wpxen.terminalCloseConfirmSuppressed';

// This pane's browser tab keys. The webview cache and the browser IPC events
// are shared with the Floating Workspace (`floating-browser:` keys), so the
// prefix is how each side knows which pages are its own.
const BROWSER_KEY_PREFIX = 'browser:';

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
// tab. The tabs are the Site's Sessions as the main process lists them — the
// same list the Projects sidebar shows — so a launch, exit or dismiss anywhere
// lands here too. The sidebar spawns or focuses a Session via navigation
// state; the "+" spawns more.
export default function AgentsPane() {
  const { siteId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  // When the sidebar is hidden the explorer sits under the floating window
  // controls; inset its tab bar so they don't overlap.
  const { controlsInset } = useOutletContext() || {};
  const { settings } = useSettings();

  const [meta, setMeta] = useState({ siteName: siteId });
  const [sitePath, setSitePath] = useState(null);
  const [agents, setAgents] = useState([]); // registry, for the "+" menu
  const [targets, setTargets] = useState([]); // saved Launch Targets for this Site
  const [settingsOpen, setSettingsOpen] = useState(false); // launch-settings dialog
  const [error, setError] = useState(null);

  const allSessions = useAgentSessions();
  const tabs = useMemo(
    () =>
      allSessions
        .filter((s) => s.siteId === siteId)
        .sort((a, b) => a.startedAt - b.startedAt),
    [allSessions, siteId]
  );
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
  const [closeConfirm, setCloseConfirm] = useState(null); // sessionId pending confirm
  const [suppressClose, setSuppressClose] = useState(false); // checkbox in dialog

  // Open a browser tab in the editor column. Keys are sequential rather than
  // URL-derived so the same URL can be open twice, and so navigating away from
  // the initial URL doesn't orphan the webview in its cache.
  //
  // Declared above the effects below because they name it in their dependency
  // arrays, which are evaluated during render — a `const` declared further down
  // would still be in its temporal dead zone at that point.
  const openBrowser = useCallback((url = 'about:blank') => {
    const key = `${BROWSER_KEY_PREFIX}${++browserSeq.current}`;
    setBrowserState((prev) => ({
      ...prev,
      [key]: { url, title: '', loading: true, error: null },
    }));
    setOpenFiles((prev) => [...prev, { key, kind: 'browser', name: 'Browser', url }]);
    setActiveKey(key);
  }, []);

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

      // A site quick action asked for this URL in-app (see useOpenLink). The
      // site-change effect clears browser tabs, so this has to run after the
      // load above rather than in its own effect.
      if (location.state?.openBrowser) openBrowser(location.state.openBrowser);

      // Honour a pending spawn or focus request from the sidebar.
      const spawnAgent = location.state?.spawn;
      let preferActive = location.state?.focus || null;
      if (spawnAgent) {
        const res = await window.electronAPI.launchAgent(
          siteId,
          spawnAgent,
          location.state?.target || null
        );
        if (cancelled) return;
        if (res?.error) setError(res.error);
        else preferActive = res?.sessionId || null;
      }

      if (preferActive) setActiveTab(preferActive);
      else {
        const all = await window.electronAPI.listAllSessions();
        if (cancelled) return;
        const first = (all || [])
          .filter((s) => s.siteId === siteId)
          .sort((a, b) => a.startedAt - b.startedAt)[0];
        setActiveTab(first?.sessionId || null);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, location.key]);

  // Drop editor tabs when the Site changes. Browser tabs are site-scoped too,
  // and their webviews would otherwise stay parked off-screen forever.
  useEffect(() => {
    webviewCache.disposeAll(BROWSER_KEY_PREFIX);
    setBrowserState({});
    setOpenFiles([]);
    setActiveKey(null);
  }, [siteId]);

  // Same on unmount — leaving the Agents screen must not leak live pages.
  useEffect(() => () => webviewCache.disposeAll(BROWSER_KEY_PREFIX), []);

  // Popups (target="_blank", window.open) are denied in the main process and
  // re-emitted here, so they land as another tab rather than a chrome-less
  // window. Link context-menu "Open in New Tab" arrives on the same channel.
  useEffect(() => {
    const api = window.electronAPI;
    // Both channels carry every browser tab's events; the Floating
    // Workspace's pages are its own business.
    const ours = (tabKey) => String(tabKey || '').startsWith(BROWSER_KEY_PREFIX);
    const offNewWindow = api.on('browser-new-window', ({ tabKey, url }) => {
      if (ours(tabKey)) openBrowser(url);
    });
    // Chords the focused page would otherwise swallow (see browser.cjs).
    const offShortcut = api.on('browser-shortcut', ({ tabKey, key }) => {
      if (!ours(tabKey)) return;
      if (key === 'w') closeFileRef.current(tabKey);
      else if (key === 'r') webviewCache.reload(tabKey);
    });
    return () => {
      offNewWindow();
      offShortcut();
    };
  }, [openBrowser]);

  // Open the "+" menu anchored just below the button, in viewport coordinates.
  const openAddMenu = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    setAddMenu((m) => (m ? null : { x: r.left, y: r.bottom + 4 }));
  };

  const spawn = async (agentId, targetId = null) => {
    setAddMenu(null);
    const res = await window.electronAPI.launchAgent(siteId, agentId, targetId);
    if (res?.error) return setError(res.error);
    if (res?.sessionId) setActiveTab(res.sessionId);
  };

  // Actually tear the Session down: stop the pty (which drops it from the
  // session list, and so from the tabs) and dispose the cached xterm.
  const destroyTab = async (sessionId) => {
    await window.electronAPI.terminalStop(sessionId);
    sessionCache.dispose(sessionId);
  };

  // Keep the active tab valid as Sessions disappear — closed here, dismissed
  // from the sidebar, or reaped. Only a tab that was actually listed counts as
  // gone: a just-launched Session may be active before its first list arrives.
  // Disposal keys off the list across ALL Sites, so switching Site keeps the
  // other Sites' terminals cached.
  const listedRef = useRef(new Set());
  const prevTabsRef = useRef([]);
  useEffect(() => {
    const ids = new Set(allSessions.map((s) => s.sessionId));
    for (const id of listedRef.current) if (!ids.has(id)) sessionCache.dispose(id);
    if (activeTab && !ids.has(activeTab) && listedRef.current.has(activeTab)) {
      const prev = prevTabsRef.current.map((t) => t.sessionId);
      const after = prev.slice(prev.indexOf(activeTab) + 1).find((id) => ids.has(id));
      const before = prev.filter((id) => ids.has(id)).pop();
      setActiveTab(after || before || null);
    }
    listedRef.current = ids;
    prevTabsRef.current = tabs;
  }, [allSessions, tabs, activeTab]);

  // Tell the sidebar which Session is on screen.
  useEffect(() => {
    setSelectedSession(siteId ? activeTab : null);
  }, [siteId, activeTab]);
  useEffect(() => () => setSelectedSession(null), []);

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

  // Respawn the same Agent after its shell exited: launch a fresh Session and
  // reap the dead one. The new Session takes the end of the tab strip.
  const respawn = async (sessionId) => {
    const tab = tabs.find((t) => t.sessionId === sessionId);
    if (!tab) return;
    const res = await window.electronAPI.launchAgent(siteId, tab.agentId, tab.targetId);
    if (res?.error) return setError(res.error);
    if (!res?.sessionId) return;
    setActiveTab(res.sessionId);
    window.electronAPI.terminalStop(sessionId);
    sessionCache.dispose(sessionId);
  };

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

  // Cmd+click on a URL in agent output. Unlike useOpenLink there's no
  // navigation to do — we're already on the Agents screen — so the in-app case
  // is just another tab.
  const handleOpenLink = useCallback(
    (url) => {
      if (settings['app.openLinksIn'] === 'app') openBrowser(url);
      else window.electronAPI.openSiteInBrowser(url);
    },
    [settings, openBrowser]
  );

  const closeFile = (key) => {
    // A browser tab's page outlives its React component by design, so closing
    // the tab is the one moment it has to be torn down for real.
    if (key.startsWith(BROWSER_KEY_PREFIX)) {
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

  // Remember the open Site, so coming back to a bare /agents — from the
  // activity bar or the main nav — lands on it instead of the empty state.
  useEffect(() => {
    if (siteId) localStorage.setItem(LAST_AGENTS_SITE_KEY, siteId);
  }, [siteId]);

  // Bare /agents: reopen the remembered Site if it still exists. Keyed on the
  // navigation, since this instance is reused across /agents and /agents/:id.
  const [restoreFailedFor, setRestoreFailedFor] = useState(null);
  useEffect(() => {
    if (siteId) return;
    const last = localStorage.getItem(LAST_AGENTS_SITE_KEY);
    if (!last) return;
    let cancelled = false;
    window.electronAPI.getSites().then((sites) => {
      if (cancelled) return;
      const id = resolveLastSite(last, sites);
      if (id) navigate(`/agents/${encodeURIComponent(id)}`, { replace: true });
      else setRestoreFailedFor(location.key);
    });
    return () => {
      cancelled = true;
    };
  }, [siteId, location.key, navigate]);

  // closeFile closes over activeKey, so the IPC subscription above reaches it
  // through a ref rather than resubscribing on every tab switch.
  const closeFileRef = useRef(closeFile);
  closeFileRef.current = closeFile;

  if (!siteId) {
    // Reopening the last Site (effect above) — render nothing rather than
    // flashing the empty state on the way there.
    if (localStorage.getItem(LAST_AGENTS_SITE_KEY) && restoreFailedFor !== location.key) {
      return null;
    }
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6">
        <div className="icon-tile w-12 h-12 bg-[#af52de] mb-4">
          <TerminalIcon size={24} strokeWidth={2} />
        </div>
        <p className="text-[15px] font-semibold text-foreground">Agents</p>
        <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">
          Add a project in the sidebar, then start an AI agent session in that
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
                  controlsInset={controlsInset}
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
              {tabs.map((tab) => {
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
                      {sessionTitle(tab, tabs)}
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
                    setBrowserMenu((m) =>
                      m ? null : { x: r.right - 220, y: r.bottom + 4 }
                    );
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
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setBrowserMenu(null)}
                />
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
                        <t.icon
                          size={14}
                          className="flex-shrink-0 text-muted-foreground"
                        />
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
              <LaunchMenu
                siteId={siteId}
                anchor={addMenu}
                agents={detected}
                targets={targets}
                onClose={() => setAddMenu(null)}
                onLaunch={spawn}
                onOpenSettings={() => {
                  setAddMenu(null);
                  setSettingsOpen(true);
                }}
              />
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
                  onOpenLink={handleOpenLink}
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
