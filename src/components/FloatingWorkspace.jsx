import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  EyeOff,
  Maximize2,
  Minimize2,
  Minus,
  PanelsTopLeft,
  Plus,
  TerminalSquare,
  X,
} from 'lucide-react';
import Terminal from './Terminal';
import AgentStatusGlyph from './AgentStatusGlyph';
import { Tooltip } from './ui';
import { useSettings } from '../lib/useSettings';
import * as sessionCache from '../lib/terminal/sessionCache';
import {
  EMPTY_WORKSPACE,
  activeTab as getActiveTab,
  newTabId,
  needsAttention,
  resolveContext,
  terminalTabTitle,
  workspaceReducer,
} from '../lib/floatingWorkspace';
import {
  isDrag,
  moveBounds,
  pointToTrigger,
  resizeBounds,
  triggerToPoint,
} from '../lib/floatingGeometry';
import { trackPointer, useFloatingGeometry } from '../lib/useFloatingGeometry';

// Floating Workspace — a launcher button in the bottom-right of every page and
// the floating panel it opens, modelled on Orca's floating terminal. Tabs are
// plain shells owned by no Site (`scope: 'floating'` in agents.cjs), so they
// stay out of the Projects list, keep-awake and the tray.
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
  const sessions = useFloatingSessions();
  const panelRef = useRef(null);
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;

  const active = getActiveTab(workspace);
  const sessionById = new Map(sessions.map((s) => [s.sessionId, s]));

  // A renderer reload (dev HMR, a crashed window) loses this component's state
  // while the main process keeps the shells — adopt any that are still there
  // rather than leaving them running with no tab.
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.listFloatingSessions().then((list) => {
      if (cancelled) return;
      for (const s of list || []) {
        dispatch({
          type: 'add',
          tab: {
            kind: 'terminal',
            id: newTabId('terminal'),
            sessionId: s.sessionId,
            cwd: s.cwd,
          },
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const newTerminal = async () => {
    setError(null);
    const sites = (await window.electronAPI.getSites()) || [];
    const { cwd } = resolveContext({
      pathname: pathnameRef.current,
      sites,
      terminalDirectory: settings['floatingWorkspace.terminalDirectory'],
    });
    const res = await window.electronAPI.launchFloatingTerminal(cwd);
    if (res?.error) return setError(res.error);
    dispatch({
      type: 'add',
      tab: { kind: 'terminal', id: newTabId('terminal'), sessionId: res.sessionId, cwd },
    });
    setOpen(true);
  };

  const closeTab = (tab) => {
    dispatch({ type: 'close', id: tab.id });
    window.electronAPI.terminalStop(tab.sessionId);
    sessionCache.dispose(tab.sessionId);
  };

  // A fresh shell in the same folder, in the same tab position.
  const restart = async (tab) => {
    setError(null);
    const res = await window.electronAPI.launchFloatingTerminal(tab.cwd);
    if (res?.error) return setError(res.error);
    dispatch({ type: 'update', id: tab.id, patch: { sessionId: res.sessionId } });
    window.electronAPI.terminalStop(tab.sessionId);
    sessionCache.dispose(tab.sessionId);
  };

  const openLink = useCallback((url) => window.electronAPI.openSiteInBrowser(url), []);

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
                    onClick={() => dispatch({ type: 'activate', id: tab.id })}
                    className={`group flex items-center gap-1.5 pl-2 pr-1 h-7 rounded-md text-[12.5px] cursor-pointer whitespace-nowrap ${
                      isActive
                        ? 'bg-muted text-foreground font-medium'
                        : 'text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    {session &&
                    ['working', 'needs-input', 'done'].includes(session.state) ? (
                      <AgentStatusGlyph state={session.state} />
                    ) : (
                      <TerminalSquare size={13} className="flex-shrink-0" />
                    )}
                    <span className="truncate max-w-[160px]">
                      {terminalTabTitle(tab, session)}
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
            <Tooltip label="New terminal">
              <button
                onClick={newTerminal}
                aria-label="New terminal"
                className="flex-shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
              >
                <Plus size={15} />
              </button>
            </Tooltip>
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

          <div className="flex-1 min-h-0 bg-background">
            {active ? (
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
                <button className="btn btn-secondary" onClick={newTerminal}>
                  <TerminalSquare size={14} />
                  New Terminal
                </button>
              </div>
            )}
          </div>
        </section>
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
