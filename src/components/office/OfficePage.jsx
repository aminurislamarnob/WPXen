import { useEffect, useState } from 'react';
import { Card, PageHeader, SegmentedTabs } from '../ui';
import { OfficeScene } from './scene/OfficeScene.jsx';
import { ROOMS, officeInRoom } from '../../lib/office/scene/rooms.js';
import { subscribePreview } from '../../lib/office/preview.js';

// Office — the claude-agent-verse 3D office: every live Claude Code session on
// this machine is a character at a desk, clustered into pods by project.
// Mounting this page lazy-starts the main-process engine over IPC; the engine
// then stays warm until quit, pushing Office snapshots on 'office-update' only
// when the reducer produced a change. The page chrome is WPXen (tokens,
// primitives); the canvas content keeps the source art direction.
//
// Room tabs (#186) will replace this pinned room; until the Antigravity
// adapter lands only the Claude Code room has sessions anyway.
const ROOM = ROOMS[0];

const EMPTY_OFFICE = { sessions: {}, waitingCount: 0 };

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

export default function OfficePage() {
  const [office, setOffice] = useState(EMPTY_OFFICE);
  const [previewMode, setPreviewMode] = useState('off');

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
  const roomOffice = officeInRoom(shown, ROOM.kind);
  const sessionCount = Object.keys(roomOffice.sessions).length;
  const waiting = roomOffice.waitingCount;

  return (
    <div className="h-full flex flex-col animate-fade-in">
      <div className="px-6 flex-shrink-0">
        <PageHeader
          title="Office"
          subtitle={
            previewOffice
              ? 'Preview — synthetic sessions, engine untouched'
              : sessionCount === 0
                ? 'Live Claude Code sessions on this machine'
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
        </PageHeader>
      </div>

      {/* Full-bleed canvas — the deliberate exception to the max-w page wrap. */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        <OfficeScene office={roomOffice} room={ROOM} />
        {sessionCount === 0 && (
          <div className="absolute left-1/2 bottom-10 -translate-x-1/2 z-10">
            <Card className="px-5 py-3.5 text-center shadow-md">
              <p className="text-[13px] font-medium text-foreground">
                The {ROOM.name} room is quiet
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">{ROOM.hint}</p>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
