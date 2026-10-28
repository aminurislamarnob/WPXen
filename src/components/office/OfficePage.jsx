import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Users } from 'lucide-react';
import { Button, Card, PageHeader, SegmentedTabs } from '../ui';
import { OfficeScene } from './scene/OfficeScene.jsx';
import { AgentList } from './AgentList.jsx';
import { InspectorPanel } from './InspectorPanel.jsx';
import { reconcileFocus } from '../../lib/office/focus.js';
import {
  ROOMS,
  officeInRoom,
  roomCounts,
  roomTheme,
} from '../../lib/office/scene/rooms.js';
import { subscribePreview } from '../../lib/office/preview.js';

// Office — the claude-agent-verse 3D office: every live Claude Code or
// Antigravity session on this machine is a character at a desk, clustered
// into pods by project, one room per agent kind. Mounting this page
// lazy-starts the main-process engine over IPC; the engine then stays warm
// until quit, pushing Office snapshots on 'office-update' only when the
// reducer produced a change. The page chrome is WPXen (tokens, primitives);
// the canvas content keeps the source art direction.
//
// Clicking a character, an intern or an agent-list row focuses it: the camera
// zooms in and the side panel swaps the agent list for the inspector. Clicking
// empty floor or the inspector's close button releases focus and the camera
// re-frames the room.

// Selected room, remembered across restarts. `wpxen.`-prefixed per the naming
// law (precedent: 'wpxen.changesViewMode' in FileExplorer.jsx).
const ROOM_STORAGE_KEY = 'wpxen.office.room';

const EMPTY_OFFICE = { sessions: {}, waitingCount: 0 };

// Side panel geometry: its width plus the gap to the canvas edge. While open on
// a wide enough canvas, the camera frames the area beside it (insetRight).
const PANEL_WIDTH = 340;
const PANEL_GAP = 12; // the panel's top-3 / right-3 / bottom-3 offsets
// Below this canvas width the panel floats over the scene instead.
const WIDE_CANVAS = 720;

// Dev-only Preview: synthetic snapshots straight into the scene, never the
// engine. `import.meta.env.DEV` is compile-time, so the menu and the preview
// wiring are dead-code-eliminated from packaged builds.
const DEV = import.meta.env.DEV;

function usePreview(mode) {
  const [office, setOffice] = useState(null);
  useEffect(() => {
    if (!DEV || mode === 'off') {
      setOffice(null);
      return;
    }
    return subscribePreview(setOffice, mode);
  }, [mode]);
  return office;
}

/** The room on screen, restored on the next launch from localStorage. */
function useRoom() {
  const [room, setRoom] = useState(() => {
    try {
      const saved = localStorage.getItem(ROOM_STORAGE_KEY);
      if (ROOMS.some((r) => r.kind === saved)) return saved;
    } catch {
      // storage blocked; start in the first room
    }
    return ROOMS[0].kind;
  });
  const choose = useCallback((next) => {
    setRoom(next);
    try {
      localStorage.setItem(ROOM_STORAGE_KEY, next);
    } catch {
      // not remembered, still switched
    }
  }, []);
  return [room, choose];
}

/** Width of an element, tracked as it resizes. */
function useWidth(ref) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export default function OfficePage() {
  const [office, setOffice] = useState(EMPTY_OFFICE);
  const [previewMode, setPreviewMode] = useState('off');
  const [room, setRoom] = useRoom();
  const [focus, setFocus] = useState(null);
  const [listOpen, setListOpen] = useState(true);
  const canvasArea = useRef(null);
  const wide = useWidth(canvasArea) >= WIDE_CANVAS;

  useEffect(() => {
    let mounted = true;
    window.electronAPI.officeStart().then((o) => {
      if (mounted && o) setOffice(o);
    });
    const off = window.electronAPI.on('office-update', setOffice);
    return () => {
      mounted = false;
      off();
    };
  }, []);

  const previewOffice = usePreview(previewMode);
  const shown = previewOffice ?? office;
  const theme = roomTheme(room);
  // Only the room on screen renders; the tabs count every room. Memoised so a
  // focus or panel change doesn't hand the scene a "new" office to re-plan.
  const roomOffice = useMemo(() => officeInRoom(shown, theme.kind), [shown, theme.kind]);
  const counts = roomCounts(shown);
  const sessionCount = Object.keys(roomOffice.sessions).length;
  const waiting = roomOffice.waitingCount;

  // Focus follows the snapshots: it clears when its session leaves the room
  // and drops back to the parent when a focused intern finishes. Rendering
  // uses the reconciled value at once; the effect brings the state in line.
  const liveFocus = reconcileFocus(roomOffice, focus);
  useEffect(() => {
    if (liveFocus !== focus) setFocus(liveFocus);
  }, [liveFocus, focus]);
  const focusedSession = liveFocus ? roomOffice.sessions[liveFocus.pid] : null;
  const sideOpen = listOpen || !!focusedSession;
  const insetRight = sideOpen && wide ? PANEL_WIDTH + PANEL_GAP * 2 : 0;

  const chooseRoom = useCallback(
    (next) => {
      setFocus(null);
      setRoom(next);
    },
    [setRoom]
  );

  return (
    <div className="h-full flex flex-col animate-fade-in">
      <div className="px-6 flex-shrink-0">
        <PageHeader
          title="Office"
          subtitle={
            previewOffice
              ? 'Preview — synthetic sessions, engine untouched'
              : sessionCount === 0
                ? `Live ${theme.name} sessions on this machine`
                : `${sessionCount} live session${sessionCount === 1 ? '' : 's'}${
                    waiting > 0 ? ` · ${waiting} waiting on you` : ''
                  }`
          }
        >
          {DEV && (
            <SegmentedTabs
              tabs={[
                { value: 'off', label: 'Preview off' },
                { value: 'cycle', label: 'Cycle' },
                { value: 'still', label: 'Still' },
              ]}
              value={previewMode}
              onChange={setPreviewMode}
            />
          )}
          <SegmentedTabs
            tabs={ROOMS.map((r) => {
              const { count, waiting: roomWaiting } = counts.find(
                (c) => c.kind === r.kind
              );
              return {
                value: r.kind,
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ background: r.accent }}
                      aria-hidden
                    />
                    {r.name}
                    <span className="tabular-nums opacity-60">{count}</span>
                    {roomWaiting > 0 && (
                      <span className="rounded-full bg-status-warning/15 text-status-warning px-1.5 py-px text-[10px] font-semibold tabular-nums">
                        {roomWaiting} waiting
                      </span>
                    )}
                  </span>
                ),
              };
            })}
            value={room}
            onChange={chooseRoom}
          />
        </PageHeader>
      </div>

      {/* Full-bleed canvas — the deliberate exception to the max-w page wrap. */}
      <div ref={canvasArea} className="relative flex-1 min-h-0 overflow-hidden">
        <OfficeScene
          office={roomOffice}
          room={theme}
          focus={liveFocus}
          onSelect={setFocus}
          insetRight={insetRight}
        />
        {sessionCount === 0 && (
          <div className="absolute left-1/2 bottom-10 -translate-x-1/2 z-10">
            <Card className="px-5 py-3.5 text-center shadow-md">
              <p className="text-[13px] font-medium text-foreground">
                The {theme.name} room is quiet
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">{theme.hint}</p>
            </Card>
          </div>
        )}

        {sideOpen ? (
          <aside
            className="panel absolute top-3 right-3 bottom-3 z-10 flex flex-col overflow-hidden max-w-[calc(100%-24px)]"
            style={{ width: PANEL_WIDTH }}
          >
            {focusedSession ? (
              <InspectorPanel
                session={focusedSession}
                focusedSubagentId={liveFocus.subagentId}
                onClose={() => setFocus(null)}
                onFocusSession={() => setFocus({ pid: focusedSession.pid })}
                onFocusSubagent={(subagentId) =>
                  setFocus({ pid: focusedSession.pid, subagentId })
                }
              />
            ) : (
              <AgentList
                office={roomOffice}
                onSelect={setFocus}
                onClose={() => setListOpen(false)}
              />
            )}
          </aside>
        ) : (
          <Button
            className="absolute top-3 right-3 z-10"
            onClick={() => setListOpen(true)}
          >
            <Users size={14} />
            Agents
            <span className="tabular-nums text-muted-foreground">{sessionCount}</span>
          </Button>
        )}
      </div>
    </div>
  );
}
