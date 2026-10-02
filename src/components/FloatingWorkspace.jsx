import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  ChevronDown,
  EyeOff,
  FileText,
  FolderOpen,
  Globe,
  Maximize2,
  Minimize2,
  Minus,
  PanelsTopLeft,
  Plus,
  TerminalSquare,
  X,
} from 'lucide-react';
import Terminal from './Terminal';
import BrowserPane from './browser/BrowserPane';
import NotePane from './NotePane';
import { Favicon } from './browser/BrowserToolbar';
import AgentStatusGlyph from './AgentStatusGlyph';
import { Tooltip } from './ui';
import { useSettings } from '../lib/useSettings';
import { registerFloatingRunner } from '../lib/floatingBus';
import * as sessionCache from '../lib/terminal/sessionCache';
import * as webviewCache from '../lib/browser/webviewCache';
import {
  EMPTY_WORKSPACE,
  activeTab as getActiveTab,
  newTabId,
  needsAttention,
  resolveContext,
  terminalTabTitle,
  browserTabTitle,
  noteTabTitle,
  workspaceReducer,
  LAYOUT_STORAGE_KEY,
  parseLayout,
  serializeLayout,
} from '../lib/floatingWorkspace';
import {
  isDrag,
  moveBounds,
  pointToTrigger,
  readStored,
  resizeBounds,
  triggerToPoint,
  writeStored,
} from '../lib/floatingGeometry';
import { trackPointer, useFloatingGeometry } from '../lib/useFloatingGeometry';

// Floating Workspace — a launcher button in the bottom-right of every page and
// the floating panel it opens, modelled on Orca's floating terminal. Terminal
// tabs are plain shells owned by no Site (`scope: 'floating'` in agents.cjs),
// so they stay out of the Projects list, keep-awake and the tray. Browser
// tabs are the in-app browser (BrowserPane + webviewCache, shared partition
// and history) under `floating-browser:` keys, which the Agents pane ignores.
// Note tabs are markdown files edited in NotePane (services/notes.cjs).
//
// The panel stays mounted while it has tabs and is only hidden with CSS when
// minimised: the active terminal stays attached and every Session keeps
// running. Only the active tab's terminal is mounted; the rest live in
// sessionCache, as on the Agents pane.
//
// Layering sits under the app's menus (z-40/50) and modals (z-[60]), so a
// dropdown or dialog opened from the page or the panel always shows on top.

function useFloatingSessions() {
  const [sessions, setSessions] = useState([]);
  useEffect(() => {
    const api = window.electronAPI;
    let cancelled = false;
    api.listFloatingSessions().then((list) => {
      if (!cancelled) setSessions(list || []);
    });
    const off = api.on('agent-floating-sessions-update', (list) =>
      setSessions(list || [])
    );
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  return sessions;
}

// ⌘⌥A toggles the panel; ⌘⌥⇧A toggles maximise. Matched by code, since ⌥
// composes a character (å) into `key`.
const chordOf = (e) => {
  if (e.code !== 'KeyA' || !e.metaKey || !e.altKey || e.ctrlKey) return null;
  return e.shiftKey ? 'floating-max' : 'floating';
};

// The "+" menu and the empty state offer the same choices.
const NEW_TAB_ACTIONS = [
  { key: 'terminal', label: 'New Terminal', icon: TerminalSquare },
  { key: 'browser', label: 'New Browser Tab', icon: Globe },
  { key: 'note', label: 'New Note', icon: FileText },
  { key: 'open-note', label: 'Open Note…', icon: FolderOpen },
];

// The 8 resize handles: edge or corner, and where it sits on the panel.
const RESIZE_HANDLES = [
  ['n', 'top-0 inset-x-2 h-1.5 cursor-ns-resize'],
  ['s', 'bottom-0 inset-x-2 h-1.5 cursor-ns-resize'],
  ['w', 'left-0 inset-y-2 w-1.5 cursor-ew-resize'],
  ['e', 'right-0 inset-y-2 w-1.5 cursor-ew-resize'],
  ['nw', 'top-0 left-0 size-2.5 cursor-nwse-resize'],
  ['se', 'bottom-0 right-0 size-2.5 cursor-nwse-resize'],
  ['ne', 'top-0 right-0 size-2.5 cursor-nesw-resize'],
  ['sw', 'bottom-0 left-0 size-2.5 cursor-nesw-resize'],
];

export default function FloatingWorkspace() {
  const location = useLocation();
  const {
    viewport,
    open,
    setOpen,
    maximized,
    setMaximized,
    bounds,
    restoredBounds,
    saveBounds,
    triggerPoint,
    saveTrigger,
  } = useFloatingGeometry();
  const { settings, setSetting, loaded: settingsLoaded } = useSettings();
  // Shown until settings say otherwise — but the launcher waits for them (see
  // the render), so a disabled one never flashes in at launch.
  const enabled = settings['floatingWorkspace.enabled'] !== false;
  const [launcherMenu, setLauncherMenu] = useState(null); // { x, y } on right-click
  // While a move or resize is under way, the live bounds; saved on release.
  const [dragBounds, setDragBounds] = useState(null);
  const [dragTrigger, setDragTrigger] = useState(null);
  const [workspace, dispatch] = useReducer(workspaceReducer, EMPTY_WORKSPACE);
  const [error, setError] = useState(null);
  const [browserState, setBrowserState] = useState({}); // tab id -> chrome state
  const [addMenu, setAddMenu] = useState(null); // { x, y } while the "+" menu is open
  const sessions = useFloatingSessions();
  const panelRef = useRef(null);
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;

  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const active = getActiveTab(workspace);
  const sessionById = new Map(sessions.map((s) => [s.sessionId, s]));

  // Bring the workspace back at launch.
  //
  // After an app restart nothing is running (no daemon — ADR 0001), so the
  // saved layout is relaunched: every terminal tab gets a fresh shell in its
  // saved cwd, in order. After a renderer-only reload (dev HMR, a crashed
  // window) the main process still has the shells, so those are adopted
  // instead — relaunching would leave them running with no tab.
  //
  // StrictMode double-invokes this; the first run is cancelled before its
  // first await resolves, so only the surviving run launches anything.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const api = window.electronAPI;
    (async () => {
      const live = (await api.listFloatingSessions()) || [];
      if (cancelled) return;
      const layout = parseLayout(readStored(LAYOUT_STORAGE_KEY));
      if (live.length > 0) {
        // Pages and notes died with the renderer, so they come back from the
        // saved layout, after the adopted shells.
        const tabs = [
          ...live.map((s) => ({
            kind: 'terminal',
            id: newTabId('terminal'),
            sessionId: s.sessionId,
            cwd: s.cwd,
          })),
          ...(layout?.tabs || []).filter((t) => t.kind !== 'terminal'),
        ];
        dispatch({ type: 'hydrate', state: { tabs, activeId: tabs[0].id } });
      } else {
        if (layout) {
          dispatch({ type: 'hydrate', state: layout });
          for (const tab of layout.tabs) {
            if (tab.kind !== 'terminal') continue;
            const res = await api.launchFloatingTerminal(tab.cwd);
            // Cancelled, or the tab was closed while its shell was starting:
            // don't leave a shell running with no tab.
            const closed = !workspaceRef.current.tabs.some((t) => t.id === tab.id);
            if (cancelled || closed) {
              if (res?.sessionId) api.terminalStop(res.sessionId);
              if (cancelled) return;
              continue;
            }
            dispatch({
              type: 'update',
              id: tab.id,
              patch: res?.sessionId
                ? { sessionId: res.sessionId }
                : { error: res?.error },
            });
          }
        }
      }
      if (!cancelled) setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Save the layout on every change — once restoring is done, so the empty
  // starting state can't overwrite what's being restored.
  useEffect(() => {
    if (hydrated) writeStored(LAYOUT_STORAGE_KEY, serializeLayout(workspace));
  }, [hydrated, workspace]);

  // A Session that vanished from the main process takes its tab with it.
  useEffect(() => {
    dispatch({ type: 'prune', sessionIds: sessions.map((s) => s.sessionId) });
  }, [sessions]);

  // Tell the main process which floating terminal is on screen, for unread.
  useEffect(() => {
    const id = open && active?.kind === 'terminal' ? active.sessionId : null;
    window.electronAPI.setFloatingView(id);
  }, [open, active]);
  useEffect(() => () => window.electronAPI.setFloatingView(null), []);

  // Turning the feature off hides the launcher and minimises the panel; its
  // tabs and shells keep running for when it comes back. Waits for settings to
  // load, so the restored open state isn't clobbered by a not-yet-read default.
  useEffect(() => {
    if (settingsLoaded && !enabled) {
      setOpen(false);
      setLauncherMenu(null);
    }
  }, [settingsLoaded, enabled, setOpen]);

  useEffect(() => {
    if (!launcherMenu) return undefined;
    const onKey = (e) => e.key === 'Escape' && setLauncherMenu(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [launcherMenu]);

  const toggle = useCallback(() => {
    if (enabled) setOpen((v) => !v);
  }, [enabled, setOpen]);
  const toggleMaximized = useCallback(() => {
    if (!enabled) return;
    setOpen(true);
    setMaximized((v) => !v);
  }, [enabled, setOpen, setMaximized]);

  // The chords from anywhere. xterm bubbles every ⌘ chord, so these fire with
  // a terminal focused too; a focused webview forwards them via
  // browser-shortcut.
  useEffect(() => {
    const run = (chord) => {
      if (chord === 'floating') toggle();
      else if (chord === 'floating-max') toggleMaximized();
      else return false;
      return true;
    };
    const onKey = (e) => {
      if (run(chordOf(e))) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    const off = window.electronAPI.on('browser-shortcut', ({ key }) => run(key));
    return () => {
      window.removeEventListener('keydown', onKey);
      off();
    };
  }, [toggle, toggleMaximized]);

  // Opening the panel remembers what had focus and puts the cursor in the
  // active terminal; minimising hands focus back, so typing carries on where
  // it was.
  const returnFocusRef = useRef(null);
  useEffect(() => {
    const panel = panelRef.current;
    if (!open) {
      const back = returnFocusRef.current;
      returnFocusRef.current = null;
      const focusIsOurs =
        !document.activeElement ||
        document.activeElement === document.body ||
        panel?.contains(document.activeElement);
      if (back?.isConnected && focusIsOurs) back.focus();
      return undefined;
    }
    const prev = document.activeElement;
    if (prev && prev !== document.body && !panel?.contains(prev)) {
      returnFocusRef.current = prev;
    }
    return undefined;
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => {
      panelRef.current?.querySelector('.xterm-helper-textarea')?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [open, active?.id]);

  // Move the panel by its title bar — from the bar itself, not from a tab or
  // button on it. Double-click toggles maximise, as a window title bar does.
  const startMove = (e) => {
    if (e.button !== 0 || maximized) return;
    if (e.target.closest('button, [data-tab]')) return;
    const start = restoredBounds;
    trackPointer(e, {
      onMove: (dx, dy) => setDragBounds(moveBounds(start, dx, dy, viewport)),
      onEnd: (dx, dy) => {
        setDragBounds(null);
        if (isDrag(dx, dy)) saveBounds(moveBounds(start, dx, dy, viewport));
      },
    });
  };

  const startResize = (edge) => (e) => {
    if (e.button !== 0 || maximized) return;
    e.stopPropagation();
    const start = restoredBounds;
    trackPointer(e, {
      onMove: (dx, dy) => setDragBounds(resizeBounds(start, edge, dx, dy, viewport)),
      onEnd: (dx, dy) => {
        setDragBounds(null);
        saveBounds(resizeBounds(start, edge, dx, dy, viewport));
      },
    });
  };

  // The launcher drags anywhere; a press that moves less than the threshold is
  // a click. Keyboard activation (detail 0) goes through onClick instead.
  const startTriggerDrag = (e) => {
    if (e.button !== 0) return;
    const start = triggerPoint;
    const at = (dx, dy) => ({ x: start.x + dx, y: start.y + dy });
    trackPointer(e, {
      onMove: (dx, dy) => {
        if (isDrag(dx, dy)) setDragTrigger(pointToTrigger(at(dx, dy), viewport));
      },
      onEnd: (dx, dy) => {
        setDragTrigger(null);
        if (isDrag(dx, dy)) saveTrigger(pointToTrigger(at(dx, dy), viewport));
        else toggle();
      },
    });
  };

  // `command`, when given, is typed into the new shell (see floatingBus).
  // Resolves the Session id, or null when the launch failed.
  const newTerminal = async ({ command, cwd: wanted } = {}) => {
    setError(null);
    let cwd = wanted;
    if (!cwd) {
      const sites = (await window.electronAPI.getSites()) || [];
      cwd = resolveContext({
        pathname: pathnameRef.current,
        sites,
        terminalDirectory: settings['floatingWorkspace.terminalDirectory'],
      }).cwd;
    }
    const res = await window.electronAPI.launchFloatingTerminal(cwd, command);
    if (res?.error) {
      setError(res.error);
      return null;
    }
    dispatch({
      type: 'add',
      tab: { kind: 'terminal', id: newTabId('terminal'), sessionId: res.sessionId, cwd },
    });
    setOpen(true);
    return res.sessionId;
  };
  const newTerminalRef = useRef(newTerminal);
  newTerminalRef.current = newTerminal;
  useEffect(() => {
    if (!settingsLoaded || !enabled) return undefined;
    return registerFloatingRunner((opts) => newTerminalRef.current(opts));
  }, [settingsLoaded, enabled]);

  // A new browser tab: the given URL, else the current Site's, else blank
  // with the address bar ready for typing.
  const newBrowser = async (url) => {
    setError(null);
    let target = url;
    if (!target) {
      const sites = (await window.electronAPI.getSites()) || [];
      target = resolveContext({ pathname: pathnameRef.current, sites }).url;
    }
    const tab = {
      kind: 'browser',
      id: newTabId('browser'),
      url: target || 'about:blank',
    };
    setBrowserState((prev) => ({
      ...prev,
      [tab.id]: {
        url: tab.url,
        title: '',
        loading: tab.url !== 'about:blank',
        error: null,
      },
    }));
    dispatch({ type: 'add', tab });
    setOpen(true);
  };

  const closeTab = (tab) => {
    dispatch({ type: 'close', id: tab.id });
    if (tab.kind === 'note') {
      // An untitled note nobody typed in is deleted, so the folder doesn't
      // fill up with empty files. Pending edits are saved by the editor as it
      // unmounts.
      window.electronAPI.notesDiscard(tab.path, !!tab.edited);
    } else if (tab.kind === 'browser') {
      // The page outlives its React component by design; closing the tab is
      // the one moment it's torn down for real.
      webviewCache.dispose(tab.id);
      setBrowserState((prev) => {
        const next = { ...prev };
        delete next[tab.id];
        return next;
      });
    } else if (tab.sessionId) {
      window.electronAPI.terminalStop(tab.sessionId);
      sessionCache.dispose(tab.sessionId);
    }
  };

  // Chrome state for each browser tab, fed by its webview. The URL is also
  // written onto the tab, so the saved layout reopens the page it was on.
  const onBrowserStateChange = useCallback((key, patch) => {
    setBrowserState((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), ...patch } }));
    if (patch.url && patch.url !== 'about:blank') {
      dispatch({ type: 'update', id: key, patch: { url: patch.url } });
    }
  }, []);

  // Popups and ⌘W/⌘R from our own pages; the Agents pane handles its own.
  const newBrowserRef = useRef(null);
  newBrowserRef.current = newBrowser;
  const closeTabByIdRef = useRef(null);
  closeTabByIdRef.current = (id) => {
    const tab = workspaceRef.current.tabs.find((t) => t.id === id);
    if (tab) closeTab(tab);
  };
  useEffect(() => {
    const api = window.electronAPI;
    const ours = (tabKey) => String(tabKey || '').startsWith('floating-browser:');
    const offNewWindow = api.on('browser-new-window', ({ tabKey, url }) => {
      if (ours(tabKey)) newBrowserRef.current(url);
    });
    const offShortcut = api.on('browser-shortcut', ({ tabKey, key }) => {
      if (!ours(tabKey)) return;
      if (key === 'w') closeTabByIdRef.current(tabKey);
      else if (key === 'r') webviewCache.reload(tabKey);
    });
    return () => {
      offNewWindow();
      offShortcut();
    };
  }, []);

  // Leaving for good (the app's window closing) takes our pages with it.
  useEffect(() => () => webviewCache.disposeAll('floating-browser:'), []);

  // A fresh shell in the same folder, in the same tab position — after the
  // shell exited, or when a restored tab's launch was refused.
  const restart = async (tab) => {
    setError(null);
    const res = await window.electronAPI.launchFloatingTerminal(tab.cwd);
    if (res?.error) {
      if (!tab.sessionId)
        dispatch({ type: 'update', id: tab.id, patch: { error: res.error } });
      else setError(res.error);
      return;
    }
    dispatch({
      type: 'update',
      id: tab.id,
      patch: { sessionId: res.sessionId, error: null },
    });
    if (tab.sessionId) {
      window.electronAPI.terminalStop(tab.sessionId);
      sessionCache.dispose(tab.sessionId);
    }
  };

  // Tell the main process whether focus is inside the panel, so it can take
  // ⌘W for the panel's tab instead of letting the menu close the window.
  useEffect(() => {
    const report = () => {
      const panel = panelRef.current;
      const inside = !!(open && panel && panel.contains(document.activeElement));
      window.electronAPI.setFloatingFocus(inside);
    };
    // focusout fires before focus lands on the next element; check after.
    const onFocusOut = () => setTimeout(report, 0);
    document.addEventListener('focusin', report);
    document.addEventListener('focusout', onFocusOut);
    report();
    return () => {
      document.removeEventListener('focusin', report);
      document.removeEventListener('focusout', onFocusOut);
      window.electronAPI.setFloatingFocus(false);
    };
  }, [open]);

  // ⌘W, taken by the main process while the panel has focus.
  const closeActiveRef = useRef(null);
  closeActiveRef.current = () => {
    if (active) closeTab(active);
    else setOpen(false);
  };
  useEffect(
    () =>
      window.electronAPI.on('floating-shortcut', ({ key }) => {
        if (key === 'w') closeActiveRef.current();
      }),
    []
  );

  // Panel-scoped chords. xterm bubbles ⌘ chords and ⌃Tab, so these arrive
  // here from a focused terminal too. Esc is deliberately left alone — the
  // terminal (vim, TUIs, agent prompts) needs it.
  const onPanelKeyDown = (e) => {
    if (e.code === 'KeyT' && e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      newTerminal();
    } else if (e.code === 'Tab' && e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      dispatch({ type: 'cycle', delta: e.shiftKey ? -1 : 1 });
    }
  };

  // Drag a tab onto another to take its place. Our own MIME type, so a file or
  // path dropped on the terminal isn't mistaken for a tab move.
  const TAB_MIME = 'application/x-wpxen-floating-tab';
  const onTabDragStart = (tab) => (e) => {
    e.dataTransfer.setData(TAB_MIME, tab.id);
    e.dataTransfer.effectAllowed = 'move';
  };
  const onTabDragOver = (e) => {
    if (!e.dataTransfer.types.includes(TAB_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const onTabDrop = (target) => (e) => {
    const id = e.dataTransfer.getData(TAB_MIME);
    if (!id) return;
    e.preventDefault();
    const index = workspace.tabs.findIndex((t) => t.id === target.id);
    dispatch({ type: 'move', id, index });
  };

  // A fresh untitled note in the notes folder.
  const newNote = async () => {
    setError(null);
    const res = await window.electronAPI.notesCreate();
    if (res?.error) return setError(res.error);
    dispatch({
      type: 'add',
      tab: { kind: 'note', id: newTabId('note'), path: res.path, edited: false },
    });
    setOpen(true);
  };

  // An existing markdown file, picked from a dialog that starts in the notes
  // folder. A note already open just gets focused.
  const openNote = async () => {
    setError(null);
    const file = await window.electronAPI.notesOpenDialog();
    if (!file) return;
    const existing = workspaceRef.current.tabs.find(
      (t) => t.kind === 'note' && t.path === file
    );
    if (existing) dispatch({ type: 'activate', id: existing.id });
    else {
      dispatch({
        type: 'add',
        tab: { kind: 'note', id: newTabId('note'), path: file, edited: false },
      });
    }
    setOpen(true);
  };

  const newTabOf = (kind) => {
    if (kind === 'browser') newBrowser();
    else if (kind === 'note') newNote();
    else if (kind === 'open-note') openNote();
    else newTerminal();
  };

  // Escape closes the "+" menu (the panel itself never binds Esc).
  useEffect(() => {
    if (!addMenu) return undefined;
    const onKey = (e) => e.key === 'Escape' && setAddMenu(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addMenu]);

  // `destination` ('system' | 'app') comes from a terminal link click; without
  // one, the setting decides. In-app here is a floating browser tab.
  const openLink = (url, destination = settings['app.openLinksIn']) => {
    if (destination === 'app') newBrowser(url);
    else window.electronAPI.openSiteInBrowser(url);
  };

  const hasTabs = workspace.tabs.length > 0;
  const attention = !open && needsAttention(sessions);
  const panelBounds = dragBounds || bounds;
  const launcherPoint = dragTrigger
    ? triggerToPoint(dragTrigger, viewport)
    : triggerPoint;

  return (
    <>
      {(open || hasTabs) && (
        <section
          ref={panelRef}
          aria-label="Floating workspace"
          aria-hidden={!open}
          onKeyDown={onPanelKeyDown}
          style={{
            left: panelBounds.x,
            top: panelBounds.y,
            width: panelBounds.width,
            height: panelBounds.height,
          }}
          className={`panel fixed z-[35] flex flex-col overflow-hidden ${
            open ? '' : 'invisible pointer-events-none'
          }`}
        >
          {!maximized &&
            RESIZE_HANDLES.map(([edge, cls]) => (
              <div
                key={edge}
                aria-hidden
                onPointerDown={startResize(edge)}
                className={`absolute z-10 ${cls}`}
              />
            ))}

          {/* Title bar: tabs, then the "+" and window controls. Dragging the
              bar's empty space moves the panel. */}
          <div
            onPointerDown={startMove}
            onDoubleClick={(e) => {
              if (!e.target.closest('button, [data-tab]')) toggleMaximized();
            }}
            className={`flex items-center gap-1 h-9 pl-1.5 pr-1 flex-shrink-0 bg-tertiary border-b border-border select-none ${
              maximized ? '' : 'cursor-grab active:cursor-grabbing'
            }`}
          >
            <div className="flex items-center gap-1 min-w-0 overflow-x-auto">
              {workspace.tabs.map((tab) => {
                const session = sessionById.get(tab.sessionId);
                const isActive = tab.id === workspace.activeId;
                return (
                  <div
                    key={tab.id}
                    data-tab
                    draggable
                    onDragStart={onTabDragStart(tab)}
                    onDragOver={onTabDragOver}
                    onDrop={onTabDrop(tab)}
                    onClick={() => dispatch({ type: 'activate', id: tab.id })}
                    className={`group flex items-center gap-1.5 pl-2 pr-1 h-7 rounded-md text-[12.5px] cursor-pointer whitespace-nowrap ${
                      isActive
                        ? 'bg-muted text-foreground font-medium'
                        : 'text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    {tab.kind === 'browser' ? (
                      <Favicon src={browserState[tab.id]?.favicon} />
                    ) : tab.kind === 'note' ? (
                      <FileText size={13} className="flex-shrink-0" />
                    ) : session &&
                      ['working', 'needs-input', 'done'].includes(session.state) ? (
                      <AgentStatusGlyph state={session.state} />
                    ) : (
                      <TerminalSquare size={13} className="flex-shrink-0" />
                    )}
                    <span className="truncate max-w-[160px]">
                      {tab.kind === 'browser'
                        ? browserTabTitle(tab, browserState[tab.id])
                        : tab.kind === 'note'
                          ? noteTabTitle(tab)
                          : terminalTabTitle(tab, session)}
                    </span>
                    {session?.unread && !isActive && (
                      <span className="size-1.5 rounded-full bg-status-warning" />
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(tab);
                      }}
                      aria-label="Close tab"
                      className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                    >
                      <X size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="flex items-center flex-shrink-0">
              <Tooltip label="New terminal" keys={['⌘', 'T']}>
                <button
                  onClick={() => newTerminal()}
                  aria-label="New terminal"
                  className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
                >
                  <Plus size={15} />
                </button>
              </Tooltip>
              <Tooltip label="New tab…" disabled={!!addMenu}>
                <button
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setAddMenu((m) => (m ? null : { x: r.left, y: r.bottom + 4 }));
                  }}
                  aria-label="New tab menu"
                  aria-haspopup="menu"
                  aria-expanded={!!addMenu}
                  className="py-1 px-0.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
                >
                  <ChevronDown size={12} />
                </button>
              </Tooltip>
            </div>
            <div className="flex-1" />
            <Tooltip
              label={maximized ? 'Restore' : 'Maximize'}
              keys={['⌘', '⌥', '⇧', 'A']}
            >
              <button
                onClick={toggleMaximized}
                aria-label={maximized ? 'Restore' : 'Maximize'}
                className="flex-shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
              >
                {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
            </Tooltip>
            <Tooltip label="Minimize" keys={['⌘', '⌥', 'A']}>
              <button
                onClick={() => setOpen(false)}
                aria-label="Minimize"
                className="flex-shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
              >
                <Minus size={15} />
              </button>
            </Tooltip>
          </div>

          {error && (
            <div className="px-3 py-1.5 text-[12px] text-destructive border-b border-border">
              {error}
            </div>
          )}

          {/* BrowserPane renders its toolbar and viewport as siblings, so it
              needs a column; terminals and the empty states fill with h-full. */}
          <div
            className={`flex-1 min-h-0 bg-background ${
              active?.kind === 'browser' ? 'flex flex-col' : ''
            }`}
          >
            {active?.kind === 'note' ? (
              <NotePane
                key={active.id}
                path={active.path}
                onEdited={() =>
                  dispatch({ type: 'update', id: active.id, patch: { edited: true } })
                }
                onOpenLink={openLink}
              />
            ) : active?.kind === 'browser' ? (
              <BrowserPane
                key={active.id}
                tabKey={active.id}
                initialUrl={active.url}
                state={
                  browserState[active.id] || {
                    url: active.url,
                    title: '',
                    loading: true,
                    error: null,
                  }
                }
                onStateChange={onBrowserStateChange}
                onClose={() => closeTab(active)}
                autoEditAddress={active.url === 'about:blank'}
              />
            ) : active && !active.sessionId ? (
              <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
                {active.error ? (
                  <>
                    <p className="text-[13px] text-foreground">
                      Couldn’t start this terminal.
                    </p>
                    <p className="text-[12px] text-muted-foreground">{active.error}</p>
                    <div className="flex gap-2">
                      <button className="btn btn-primary" onClick={() => restart(active)}>
                        Retry
                      </button>
                      <button
                        className="btn btn-secondary"
                        onClick={() => closeTab(active)}
                      >
                        Close
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="text-[13px] text-muted-foreground">Starting…</p>
                )}
              </div>
            ) : active ? (
              <Terminal
                key={active.sessionId}
                sessionId={active.sessionId}
                rootPath={sessionById.get(active.sessionId)?.cwd || null}
                onOpenLink={openLink}
                onExited={() => closeTab(active)}
                onRestart={() => restart(active)}
              />
            ) : (
              <div className="h-full flex flex-col items-center justify-center gap-3 text-center">
                <p className="text-[13px] text-muted-foreground">Nothing open yet.</p>
                <div className="flex flex-wrap justify-center gap-2">
                  {NEW_TAB_ACTIONS.map(({ key, label, icon: Icon }) => (
                    <button
                      key={key}
                      className="btn btn-secondary"
                      onClick={() => newTabOf(key)}
                    >
                      <Icon size={14} />
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {addMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setAddMenu(null)} />
          <div
            role="menu"
            aria-label="New tab"
            className="panel-menu fixed z-50 w-48 p-1"
            style={{
              left: Math.min(addMenu.x, viewport.width - 200),
              top: addMenu.y,
            }}
          >
            {NEW_TAB_ACTIONS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                role="menuitem"
                className="panel-item"
                onClick={() => {
                  setAddMenu(null);
                  newTabOf(key);
                }}
              >
                <Icon size={14} className="text-muted-foreground" />
                {label}
              </button>
            ))}
          </div>
        </>
      )}

      {settingsLoaded && enabled && (
        <Tooltip
          label="Floating workspace"
          keys={['⌘', '⌥', 'A']}
          side="left"
          disabled={!!launcherMenu}
        >
          <button
            onPointerDown={startTriggerDrag}
            onContextMenu={(e) => {
              e.preventDefault();
              setLauncherMenu({ x: e.clientX, y: e.clientY });
            }}
            onClick={(e) => {
              // Pointer clicks are resolved on release (click vs drag); this
              // handles Enter/Space only.
              if (e.detail === 0) toggle();
            }}
            aria-label={open ? 'Minimize floating workspace' : 'Open floating workspace'}
            aria-expanded={open}
            style={{ left: launcherPoint.x, top: launcherPoint.y }}
            className="fixed z-[36] size-9 touch-none flex items-center justify-center rounded-lg bg-popover border border-border shadow-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <PanelsTopLeft size={17} strokeWidth={1.8} />
            {attention && (
              <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-status-warning ring-2 ring-background" />
            )}
          </button>
        </Tooltip>
      )}

      {launcherMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setLauncherMenu(null)} />
          <div
            role="menu"
            aria-label="Floating workspace"
            className="panel-menu fixed z-50 w-60 p-1"
            style={{
              left: Math.min(launcherMenu.x, viewport.width - 248),
              top: Math.min(launcherMenu.y, viewport.height - 56),
            }}
          >
            <button
              role="menuitem"
              onClick={() => {
                setLauncherMenu(null);
                setSetting('floatingWorkspace.enabled', false);
              }}
              className="panel-item items-start text-left"
            >
              <EyeOff size={14} className="mt-0.5 flex-shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block">Hide Floating Workspace</span>
                <span className="block text-[11px] text-muted-foreground">
                  Turn it back on in Settings → General
                </span>
              </span>
            </button>
          </div>
        </>
      )}
    </>
  );
}
