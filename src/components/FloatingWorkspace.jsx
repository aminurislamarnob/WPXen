import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Minus, PanelsTopLeft, Plus, TerminalSquare, X } from 'lucide-react';
import Terminal from './Terminal';
import AgentStatusGlyph from './AgentStatusGlyph';
import { Tooltip } from './ui';
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

const isToggleChord = (e) =>
  e.code === 'KeyA' && e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey;

export default function FloatingWorkspace() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
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

  const toggle = useCallback(() => setOpen((v) => !v), []);

  // ⌘⌥A from anywhere. xterm bubbles every ⌘ chord, so this fires with a
  // terminal focused too; a focused webview forwards it via browser-shortcut.
  useEffect(() => {
    const onKey = (e) => {
      if (!isToggleChord(e)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    const off = window.electronAPI.on('browser-shortcut', ({ key }) => {
      if (key === 'floating') toggle();
    });
    return () => {
      window.removeEventListener('keydown', onKey);
      off();
    };
  }, [toggle]);

  // Opening the panel puts the cursor in the active terminal.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      panelRef.current?.querySelector('.xterm-helper-textarea')?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [open, active?.id]);

  const newTerminal = async () => {
    setError(null);
    const sites = (await window.electronAPI.getSites()) || [];
    const { cwd } = resolveContext({ pathname: pathnameRef.current, sites });
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

  return (
    <>
      {(open || hasTabs) && (
        <section
          ref={panelRef}
          aria-label="Floating workspace"
          aria-hidden={!open}
          className={`panel fixed z-[35] right-6 bottom-[84px] flex flex-col overflow-hidden w-[min(920px,calc(100vw-48px))] h-[min(560px,calc(100vh-120px))] ${
            open ? '' : 'invisible pointer-events-none'
          }`}
        >
          {/* Title bar: tabs, then the "+" and window controls. */}
          <div className="flex items-center gap-1 h-9 pl-1.5 pr-1 flex-shrink-0 bg-tertiary border-b border-border">
            <div className="flex items-center gap-1 min-w-0 overflow-x-auto">
              {workspace.tabs.map((tab) => {
                const session = sessionById.get(tab.sessionId);
                const isActive = tab.id === workspace.activeId;
                return (
                  <div
                    key={tab.id}
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

      <Tooltip label="Floating workspace" keys={['⌘', '⌥', 'A']} side="left">
        <button
          onClick={toggle}
          aria-label={open ? 'Minimize floating workspace' : 'Open floating workspace'}
          aria-expanded={open}
          className="fixed z-[36] right-6 bottom-[72px] size-9 flex items-center justify-center rounded-lg bg-popover border border-border shadow-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          <PanelsTopLeft size={17} strokeWidth={1.8} />
          {attention && (
            <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-status-warning ring-2 ring-background" />
          )}
        </button>
      </Tooltip>
    </>
  );
}
