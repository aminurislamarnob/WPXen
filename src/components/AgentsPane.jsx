import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useParams, useLocation, useNavigate, useOutletContext } from 'react-router-dom';
import {
  Terminal as TerminalIcon,
  Plus,
  Globe,
  Gauge,
  Database,
  Mail,
  Loader2,
} from 'lucide-react';
import { ProviderIcon } from './providerIcons';
import { Panel, PanelGroup } from 'react-resizable-panels';
import SplitLayout from './agents/SplitLayout';
import FileExplorer from './FileExplorer';
import CodeEditor from './CodeEditor';
import ResizeHandle from './ResizeHandle';
import LaunchTargetsDialog from './LaunchTargetsDialog';
import LaunchMenu from './LaunchMenu';
import { ConfirmDialog } from './ui';
import * as sessionCache from '../lib/terminal/sessionCache';
import * as webviewCache from '../lib/browser/webviewCache';
import { useSettings } from '../lib/useSettings';
import { LAST_AGENTS_SITE_KEY, resolveLastSite } from '../lib/activityBar';
import { useAgentSessions, setSelectedSession } from '../lib/useAgentSessions';
import TabStrip from './agents/TabStrip';
import TabContextMenu from './agents/TabContextMenu';
import {
  tabsToClose,
  closeImpact,
  nextActive,
  needsBulkConfirm,
  paneIds,
} from '../lib/tabStrip';

const CLOSE_CONFIRM_KEY = 'wpxen.terminalCloseConfirmSuppressed';
// The registry id of the plain shell (`SHELL_ID` in services/agents.cjs).
const SHELL_AGENT_ID = 'shell';

// Whether the right-hand Explorer is collapsed — one choice for every
// project, like Orca's right sidebar, kept across restarts.
const EXPLORER_COLLAPSED_KEY = 'wpxen.agentsExplorerCollapsed';

// Its width, in pixels like Orca's (default 350, min 220, and always leaving
// 320 for the rest), so it holds its size as the window grows or shrinks
// instead of scaling with it.
const EXPLORER_WIDTH_KEY = 'wpxen.agentsExplorerWidth';
const EXPLORER_DEFAULT_WIDTH = 350;
const EXPLORER_MIN_WIDTH = 220;
const EXPLORER_MIN_REST = 320;

function readExplorerWidth() {
  try {
    const n = Number(localStorage.getItem(EXPLORER_WIDTH_KEY));
    return Number.isFinite(n) && n > 0 ? n : EXPLORER_DEFAULT_WIDTH;
  } catch {
    return EXPLORER_DEFAULT_WIDTH;
  }
}

const clampExplorerWidth = (px, groupWidth) =>
  Math.min(
    Math.max(EXPLORER_MIN_WIDTH, groupWidth - EXPLORER_MIN_REST),
    Math.max(EXPLORER_MIN_WIDTH, px)
  );

function readExplorerCollapsed() {
  try {
    return localStorage.getItem(EXPLORER_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

// This pane's browser tab keys. The webview cache and the browser IPC events
// are shared with the Floating Workspace (`floating-browser:` keys), so the
// prefix is how each side knows which pages are its own.
const BROWSER_KEY_PREFIX = 'browser:';

// The places you actually want to look at while an agent works on a site.
// Order is by how often they're reached for, not alphabetical. `wp` ones need
// a WordPress Site behind the project, so a folder project leaves them out.
const BROWSER_TARGETS = [
  { id: 'site', label: 'Site', icon: Globe, wp: true },
  { id: 'wp-admin', label: 'WP Admin', icon: Gauge, wp: true },
  { id: 'phpmyadmin', label: 'phpMyAdmin', icon: Database, wp: true },
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
  // When the sidebar is hidden the terminal's tab strip sits under the
  // floating window controls; inset it so they don't overlap.
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
        .filter((s) => s.siteId === siteId && !s.paneOf)
        .sort((a, b) => a.startedAt - b.startedAt),
    [allSessions, siteId]
  );
  const [activeTab, setActiveTab] = useState(null); // sessionId
  const [activePaneId, setActivePaneId] = useState(null); // focused pane inside activeTab
  const sessionsById = useMemo(
    () => Object.fromEntries(allSessions.map((s) => [s.sessionId, s])),
    [allSessions]
  );
  const [addMenu, setAddMenu] = useState(null); // { x, y } when the + menu is open
  const [browserMenu, setBrowserMenu] = useState(null); // { x, y } for the browser targets
  const [browserBusy, setBrowserBusy] = useState(null); // target id being resolved

  const [openFiles, setOpenFiles] = useState([]); // editor tabs [{ key, kind, ... }]
  const [activeKey, setActiveKey] = useState(null);
  // Files and browsers open in the same strip and the same area as the
  // terminals, after Orca, rather than in a split beside them. `view` says
  // which of the two kinds is on screen; activeTab / activeKey each remember
  // their own last pick so switching back lands where it was.
  const [view, setView] = useState('session'); // 'session' | 'file'
  const [dirtyKeys, setDirtyKeys] = useState([]); // file tabs with unsaved edits
  // Per-browser-tab chrome state, fed by the webview's own events. The pages
  // themselves live in webviewCache, not here.
  const [browserState, setBrowserState] = useState({}); // key -> {url,title,loading,error}
  const browserSeq = useRef(0);
  const [closeConfirm, setCloseConfirm] = useState(null); // { id, scope: tab | pane } pending confirm
  const [suppressClose, setSuppressClose] = useState(false); // checkbox in dialog

  // The Explorer is a collapsible right sidebar: the toolbar button, ⌘⇧E, or
  // dragging its handle to the edge close it.
  const explorerRef = useRef(null);
  const [explorerCollapsed, setExplorerCollapsed] = useState(readExplorerCollapsed);
  useEffect(() => {
    try {
      localStorage.setItem(EXPLORER_COLLAPSED_KEY, explorerCollapsed ? '1' : '0');
    } catch {
      // storage unavailable — the choice lasts this session only
    }
  }, [explorerCollapsed]);
  // The panels lay out in percentages, so the pixel width is converted
  // against the group's measured width — and re-applied when that changes.
  const [groupWidth, setGroupWidth] = useState(0);
  const groupWidthRef = useRef(0);
  const explorerWidth = useRef(readExplorerWidth());
  const groupObserver = useRef(null);
  const measureGroup = useCallback((node) => {
    groupObserver.current?.disconnect();
    groupObserver.current = null;
    if (!node) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      groupWidthRef.current = w;
      setGroupWidth(w);
    });
    ro.observe(node);
    groupObserver.current = ro;
  }, []);
  const explorerPercent = (px) =>
    groupWidth ? (clampExplorerWidth(px, groupWidth) / groupWidth) * 100 : 20;
  const onExplorerResize = useCallback((size) => {
    const w = groupWidthRef.current;
    if (!w || size <= 0) return;
    const px = (size / 100) * w;
    // Squeezed against the cap by a narrow window, not chosen — keep the
    // preferred width so it comes back when the window grows again.
    if (Math.abs(px - (w - EXPLORER_MIN_REST)) < 2 && explorerWidth.current > px) return;
    explorerWidth.current = px;
    try {
      localStorage.setItem(EXPLORER_WIDTH_KEY, String(Math.round(explorerWidth.current)));
    } catch {
      // storage unavailable — the width lasts this session only
    }
  }, []);
  const toggleExplorer = useCallback(() => {
    const panel = explorerRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  }, []);
  useEffect(() => {
    const onKey = (e) => {
      if (
        e.metaKey &&
        e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey &&
        e.key.toLowerCase() === 'e'
      ) {
        e.preventDefault();
        toggleExplorer();
        return;
      }
      if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const dir = e.shiftKey ? 'down' : 'right';
        if (activeTab && !showingFile) {
          window.electronAPI.splitPane(activeTab, dir);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleExplorer, activeTab, showingFile]);

  // ⌘W belongs to the app menu (Close Window), so the main process only
  // forwards it while a terminal pane here has focus — see paneFocus below.
  const closePaneRef = useRef(null);
  useEffect(() => {
    return window.electronAPI.on('agents-shortcut', (e) => {
      if (e.key === 'w' && activePaneId) closePaneRef.current(activePaneId);
    });
  }, [activePaneId]);
  const paneFocus = (sessionId) => {
    setActivePaneId(sessionId);
    window.electronAPI.setAgentsFocus(true);
  };
  const paneBlur = () => window.electronAPI.setAgentsFocus(false);
  useEffect(() => () => window.electronAPI.setAgentsFocus(false), []);

  // Hold the Explorer's pixel width as the window resizes.
  useEffect(() => {
    const panel = explorerRef.current;
    if (!panel || !groupWidth || panel.isCollapsed()) return;
    panel.resize(
      (clampExplorerWidth(explorerWidth.current, groupWidth) / groupWidth) * 100
    );
  }, [groupWidth]);

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
    setView('file');
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
        // Sites and folder projects alike — a project id may name either.
        window.electronAPI.getAgentProjectRecords(),
        window.electronAPI.listAgents(),
        window.electronAPI.listLaunchTargets(siteId),
      ]);
      if (cancelled) return;
      const site = (sites || []).find((s) => s.id === siteId);
      // url/dbName feed the browser target menu; keep them alongside the name.
      setMeta({
        siteName: site?.name || siteId,
        kind: site?.kind || 'site',
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

      if (preferActive) {
        setActiveTab(preferActive);
        setView('session');
      } else {
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
    setView('session');
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
    if (res?.sessionId) selectSession(res.sessionId);
  };

  const selectSession = (sessionId) => {
    setActiveTab(sessionId);
    setView('session');
  };

  const selectFile = (key) => {
    setActiveKey(key);
    setView('file');
  };

  // Actually tear the tab down: stop every pane's pty (which drops them from
  // the session list, and so from the tabs) and dispose the cached xterms.
  const destroyTab = async (sessionId) => {
    const ids = paneIds(sessionsById[sessionId]?.layout, sessionId);
    await window.electronAPI.terminalStopTab(sessionId);
    ids.forEach((id) => sessionCache.dispose(id));
  };

  // One pane of a split; its sibling takes the space.
  const destroyPane = async (sessionId) => {
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
      // Its first pane closed while others remain: the main process promoted
      // the next pane, so the tab lives on under that id.
      const prevLayout = prevTabsRef.current.find(
        (t) => t.sessionId === activeTab
      )?.layout;
      const promoted = paneIds(prevLayout, activeTab).find((id) =>
        tabs.some((t) => t.sessionId === id)
      );
      const prev = prevTabsRef.current.map((t) => t.sessionId);
      const after = prev.slice(prev.indexOf(activeTab) + 1).find((id) => ids.has(id));
      const before = prev.filter((id) => ids.has(id)).pop();
      setActiveTab(promoted || after || before || null);
    }
    listedRef.current = ids;
    prevTabsRef.current = tabs;
  }, [allSessions, tabs, activeTab]);

  // Tell the sidebar which Session is on screen — none while a file or
  // browser tab covers the terminal, so its output still counts as unread.
  const showingFile = view === 'file' && openFiles.some((f) => f.key === activeKey);
  useEffect(() => {
    setSelectedSession(siteId && !showingFile ? activeTab : null);
  }, [siteId, activeTab, showingFile]);
  useEffect(() => () => setSelectedSession(null), []);

  // Close request from the tab's X: confirm first if the session is still
  // running and the user hasn't suppressed the prompt. An already-exited
  // session closes without asking.
  const closeTab = (sessionId) => {
    const { running } = closeImpact([sessionId], sessionsById, []);
    if (running === 0 || localStorage.getItem(CLOSE_CONFIRM_KEY) === '1') {
      return destroyTab(sessionId);
    }
    setSuppressClose(false);
    setCloseConfirm({ id: sessionId, scope: 'tab' });
  };

  // A single pane, from its close button or ⌘W. An unsplit tab closes as a
  // tab; in a split, only a running Agent asks first — plain shells just go.
  const requestClosePane = (sessionId) => {
    const s = sessionsById[sessionId];
    if (!s) return;
    const rootId = s.paneOf || sessionId;
    if (!sessionsById[rootId]?.layout) return closeTab(rootId);
    if (
      s.exited ||
      s.agentId === SHELL_AGENT_ID ||
      localStorage.getItem(CLOSE_CONFIRM_KEY) === '1'
    ) {
      return destroyPane(sessionId);
    }
    setSuppressClose(false);
    setCloseConfirm({ id: sessionId, scope: 'pane' });
  };
  closePaneRef.current = requestClosePane;

  const confirmClose = () => {
    if (suppressClose) localStorage.setItem(CLOSE_CONFIRM_KEY, '1');
    const { id, scope } = closeConfirm;
    setCloseConfirm(null);
    if (scope === 'pane') destroyPane(id);
    else destroyTab(id);
  };

  const [tabMenu, setTabMenu] = useState(null);
  const [bulkCloseConfirm, setBulkCloseConfirm] = useState(null);

  const handleBulkClose = (action, targetKey) => {
    const sessionKeys = tabs.map((t) => t.sessionId);
    const fileKeys = openFiles.map((f) => f.key);
    const orderedKeys = [...sessionKeys, ...fileKeys];

    const keysToClose = tabsToClose(orderedKeys, targetKey, action);
    if (keysToClose.length === 0) return;

    const impact = closeImpact(keysToClose, sessionsById, dirtyKeys);

    const performClose = () => {
      const closingFiles = keysToClose.filter((k) => fileKeys.includes(k));
      for (const key of closingFiles) {
        closeFileRef.current(key);
      }

      const closingSessions = keysToClose.filter((k) => sessionKeys.includes(k));
      for (const sessionId of closingSessions) {
        destroyTab(sessionId);
      }

      const activeKeyToUse = showingFile ? activeKey : activeTab;
      const nextKey = nextActive(orderedKeys, keysToClose, activeKeyToUse);

      if (nextKey) {
        if (sessionKeys.includes(nextKey)) {
          selectSession(nextKey);
        } else {
          selectFile(nextKey);
        }
      } else {
        setView('session');
        setActiveTab(null);
        setActiveKey(null);
      }
    };

    if (needsBulkConfirm(impact, localStorage.getItem(CLOSE_CONFIRM_KEY) === '1')) {
      setBulkCloseConfirm({ action, targetKey, impact, performClose });
      setSuppressClose(false);
    } else {
      performClose();
    }
  };

  const onTabContextMenu = (e, key, kind) => {
    e.preventDefault();
    const sessionKeys = tabs.map((t) => t.sessionId);
    const fileKeys = openFiles.map((f) => f.key);
    const orderedKeys = [...sessionKeys, ...fileKeys];

    const canClose = tabsToClose(orderedKeys, key, 'close').length > 0;
    const canCloseOthers = tabsToClose(orderedKeys, key, 'others').length > 0;
    const canCloseRight = tabsToClose(orderedKeys, key, 'right').length > 0;
    const canCloseLeft = tabsToClose(orderedKeys, key, 'left').length > 0;

    const items = [];
    if (kind === 'session') {
      items.push({
        label: 'Split right',
        onClick: () => window.electronAPI.splitPane(key, 'right'),
      });
      items.push({
        label: 'Split down',
        onClick: () => window.electronAPI.splitPane(key, 'down'),
      });
      items.push('separator');
    }

    items.push({
      label: 'Close',
      disabled: !canClose,
      onClick: () => handleBulkClose('close', key),
    });

    setTabMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        ...items,
        {
          label: 'Close Others',
          disabled: !canCloseOthers,
          onClick: () => handleBulkClose('others', key),
        },
        {
          label: 'Close Tabs to the Right',
          disabled: !canCloseRight,
          onClick: () => handleBulkClose('right', key),
        },
        {
          label: 'Close Tabs to the Left',
          disabled: !canCloseLeft,
          onClick: () => handleBulkClose('left', key),
        },
      ],
    });
  };

  // Respawn the same Agent after its shell exited: launch a fresh Session and
  // reap the dead one. The new Session takes the end of the tab strip. In a
  // split, the main process swaps the pane in place instead.
  const respawn = async (sessionId) => {
    const s = sessionsById[sessionId];
    if (s?.paneOf || s?.layout) {
      const res = await window.electronAPI.respawnPane(sessionId);
      if (res?.error) return setError(res.error);
      sessionCache.dispose(sessionId);
      if (res.rootId !== (s.paneOf || sessionId)) selectSession(res.rootId);
      return;
    }
    const tab = tabs.find((t) => t.sessionId === sessionId);
    if (!tab) return;
    const res = await window.electronAPI.launchAgent(siteId, tab.agentId, tab.targetId);
    if (res?.error) return setError(res.error);
    if (!res?.sessionId) return;
    selectSession(res.sessionId);
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
    setView('file');
  }, []);

  // Open a plain (editable) file tab, keyed by its absolute path.
  const openFile = (entry) => {
    const key = entry.path;
    setOpenFiles((prev) =>
      prev.some((f) => f.key === key)
        ? prev
        : [...prev, { key, kind: 'file', path: entry.path, name: entry.name }]
    );
    selectFile(key);
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
    selectFile(key);
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
  // `destination` ('system' | 'app') comes from a terminal link click; without
  // one, the setting decides.
  const handleOpenLink = useCallback(
    (url, destination = settings['app.openLinksIn']) => {
      if (destination === 'app') openBrowser(url);
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
        const neighbour = (next[idx] || next[idx - 1])?.key || null;
        setActiveKey(neighbour);
        // Last file closed — the terminal is what's left to show.
        if (!neighbour) setView('session');
      }
      return next;
    });
  };

  // Closing from the strip; the editor's own close button asks the same.
  const requestCloseFile = (key) => {
    if (dirtyKeys.includes(key) && !window.confirm('Discard unsaved changes?')) return;
    closeFile(key);
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
    window.electronAPI.getAgentProjectRecords().then((sites) => {
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
          Add a site or any folder as a project in the sidebar, then start an AI agent
          session in it.
        </p>
      </div>
    );
  }

  const explorerDefault = explorerPercent(explorerWidth.current);
  const detected = agents.filter((a) => a.detected);
  // The active editor tab, when it's a real file (not a diff) — drives the
  // "reveal in tree" behavior in the explorer.
  const activeTabEntry = openFiles.find((f) => f.key === activeKey) || null;
  const activeFileTab =
    showingFile && activeTabEntry?.kind === 'file' ? activeTabEntry : null;

  return (
    <>
      <div ref={measureGroup} className="h-full">
        {groupWidth > 0 && (
          <PanelGroup
            direction="horizontal"
            autoSaveId="agents-2pane-right"
            className="h-full"
          >
            {/* Main column: one tab strip for Sessions, files and browsers,
                and the active one beneath it */}
            <Panel
              id="terminal"
              order={1}
              minSize={20}
              defaultSize={100 - (sitePath && !explorerCollapsed ? explorerDefault : 0)}
            >
              <div className="h-full min-w-0 flex flex-col">
                {/* Tab strip */}
                <TabStrip
                  tabs={tabs}
                  openFiles={openFiles}
                  activeTab={activeTab}
                  activeKey={activeKey}
                  showingFile={showingFile}
                  selectSession={selectSession}
                  selectFile={selectFile}
                  closeTab={closeTab}
                  requestCloseFile={requestCloseFile}
                  browserState={browserState}
                  dirtyKeys={dirtyKeys}
                  openAddMenu={openAddMenu}
                  detectedCount={detected.length}
                  setSettingsOpen={setSettingsOpen}
                  setBrowserMenu={setBrowserMenu}
                  toggleExplorer={toggleExplorer}
                  sitePath={sitePath}
                  explorerCollapsed={explorerCollapsed}
                  controlsInset={controlsInset}
                  onTabContextMenu={onTabContextMenu}
                />

                {tabMenu && (
                  <TabContextMenu
                    x={tabMenu.x}
                    y={tabMenu.y}
                    items={tabMenu.items}
                    onClose={() => setTabMenu(null)}
                  />
                )}

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
                      {BROWSER_TARGETS.filter((t) => !t.wp || meta.kind !== 'folder').map(
                        (t) => (
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
                        )
                      )}
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
                {/* The editor stays mounted while a terminal is shown, so unsaved
              edits survive the switch; with no active key it renders no page,
              which also parks any browser tab's webview. */}
                <div
                  className={
                    showingFile ? 'flex-1 min-h-0 border-t border-border' : 'hidden'
                  }
                >
                  <CodeEditor
                    rootPath={sitePath}
                    files={openFiles}
                    activeKey={showingFile ? activeKey : null}
                    onClose={closeFile}
                    onDirtyChange={setDirtyKeys}
                    browserState={browserState}
                    onBrowserStateChange={onBrowserStateChange}
                  />
                </div>

                <div className={showingFile ? 'hidden' : 'flex-1 min-h-0 px-4 pb-4'}>
                  {showingFile ? null : activeTab ? (
                    <SplitLayout
                      key={activeTab}
                      rootId={activeTab}
                      activeId={activeTab}
                      tree={
                        tabs.find((t) => t.sessionId === activeTab)?.layout ?? {
                          leaf: activeTab,
                        }
                      }
                      rootPath={sitePath}
                      onOpenFile={openFileAtLine}
                      onOpenLink={handleOpenLink}
                      onExited={requestClosePane}
                      onRestart={respawn}
                      onFocusPane={paneFocus}
                      onBlurPane={paneBlur}
                      onClosePane={requestClosePane}
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

            {/* Project explorer — a collapsible right sidebar, after Orca's */}
            {sitePath && (
              <>
                <ResizeHandle />
                <Panel
                  id="explorer"
                  order={3}
                  ref={explorerRef}
                  defaultSize={explorerCollapsed ? 0 : explorerDefault}
                  minSize={explorerPercent(EXPLORER_MIN_WIDTH)}
                  collapsible
                  collapsedSize={0}
                  onCollapse={() => setExplorerCollapsed(true)}
                  onExpand={() => setExplorerCollapsed(false)}
                  onResize={onExplorerResize}
                >
                  <div className="h-full border-l border-border">
                    <FileExplorer
                      rootPath={sitePath}
                      rootName={meta.siteName}
                      onOpenFile={openFile}
                      onOpenDiff={openDiff}
                      activeFilePath={activeFileTab?.path}
                    />
                  </div>
                </Panel>
              </>
            )}
          </PanelGroup>
        )}
      </div>
      <ConfirmDialog
        open={closeConfirm != null || bulkCloseConfirm != null}
        title={bulkCloseConfirm ? 'Close tabs?' : 'End session?'}
        description={
          closeConfirm
            ? `This will terminate the running agent in ${sessionsById[closeConfirm.id]?.agentName || 'this session'}${closeConfirm.scope === 'tab' && sessionsById[closeConfirm.id]?.layout ? ' and every pane split from it' : ''}. Anything it is doing will be interrupted.`
            : bulkCloseConfirm
              ? `${bulkCloseConfirm.impact.running} running session${bulkCloseConfirm.impact.running === 1 ? '' : 's'} will be stopped${bulkCloseConfirm.impact.dirty.length > 0 ? `, and ${bulkCloseConfirm.impact.dirty.length} file${bulkCloseConfirm.impact.dirty.length === 1 ? ' has' : 's have'} unsaved changes` : ''}.`
              : ''
        }
        confirmLabel={bulkCloseConfirm ? 'Close Tabs' : 'End Session'}
        danger
        onConfirm={
          closeConfirm
            ? confirmClose
            : () => {
                if (suppressClose) localStorage.setItem(CLOSE_CONFIRM_KEY, '1');
                bulkCloseConfirm.performClose();
                setBulkCloseConfirm(null);
              }
        }
        onCancel={() => {
          setCloseConfirm(null);
          setBulkCloseConfirm(null);
        }}
      >
        {(closeConfirm != null || bulkCloseConfirm?.impact.running > 0) && (
          <label className="mt-3 flex items-center gap-2 text-[12.5px] text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={suppressClose}
              onChange={(e) => setSuppressClose(e.target.checked)}
            />
            Don&rsquo;t ask again
          </label>
        )}
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
