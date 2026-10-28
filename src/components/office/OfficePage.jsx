import { useEffect, useState } from 'react';
import { Building2, Circle } from 'lucide-react';
import { Card, PageHeader, Row, SectionLabel } from '../ui';

// Office — live Claude Code sessions on this machine (ticket #181's tracer
// slice: the debug list; the 3D scene follows in later tickets). Mounting this
// page lazy-starts the main-process engine over IPC; the engine then stays
// warm until quit, pushing Office snapshots on 'office-update' only when the
// reducer produced a change.

// Agent State → presentation, on semantic tokens only. waiting_on_user is the
// state that blocks on the user, so it alone gets a filled pill; the rest are
// a dot + label. working/thinking share the brand blue until the scene's own
// state palette lands (#182).
const STATE_META = {
  working: { label: 'Working', className: 'text-highlight' },
  thinking: { label: 'Thinking', className: 'text-highlight' },
  idle: { label: 'Idle', className: 'text-status-running' },
  error: { label: 'Error', className: 'text-status-error' },
  ended: { label: 'Ended', className: 'text-muted-foreground' },
};

function StateBadge({ session }) {
  if (session.state === 'waiting_on_user') {
    return (
      <span className="inline-flex items-center gap-1.5 border border-status-warning/30 bg-status-warning/10 text-status-warning px-2 py-0.5 rounded-full text-xs font-semibold flex-shrink-0">
        <Circle size={6} className="fill-current status-dot-running" />
        Waiting on you
      </span>
    );
  }
  const meta = STATE_META[session.state] ?? {
    label: session.state,
    className: 'text-muted-foreground',
  };
  const onBreak = session.state === 'idle' && session.onBreak;
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium flex-shrink-0 ${meta.className}`}
    >
      <Circle size={6} className="fill-current" />
      {onBreak ? 'On break' : meta.label}
      {session.state === 'working' && session.currentTool && (
        <span className="text-muted-foreground font-normal">· {session.currentTool}</span>
      )}
    </span>
  );
}

// Sessions clustered by project key (git repo name or folder basename), the
// same grouping the 3D office uses for its pods.
function groupByProject(office) {
  const groups = new Map();
  for (const session of Object.values(office?.sessions ?? {})) {
    const list = groups.get(session.projectKey) ?? [];
    list.push(session);
    groups.set(session.projectKey, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([projectKey, sessions]) => ({
      projectKey,
      sessions: sessions.sort((a, b) => a.startedAt - b.startedAt),
    }));
}

export default function OfficePage() {
  const [office, setOffice] = useState(null);

  useEffect(() => {
    let mounted = true;
    window.electronAPI.officeStart().then((o) => {
      if (mounted) setOffice(o);
    });
    const off = window.electronAPI.on('office-update', setOffice);
    return () => {
      mounted = false;
      off();
    };
  }, []);

  const groups = groupByProject(office);
  const sessionCount = Object.keys(office?.sessions ?? {}).length;
  const waiting = office?.waitingCount ?? 0;

  return (
    <div className="px-6 pb-6 max-w-[735px] mx-auto animate-fade-in">
      <PageHeader
        title="Office"
        subtitle={
          sessionCount === 0
            ? 'Live Claude Code sessions on this machine'
            : `${sessionCount} live session${sessionCount === 1 ? '' : 's'}${
                waiting > 0 ? ` · ${waiting} waiting on you` : ''
              }`
        }
      />

      {sessionCount === 0 ? (
        <Card className="px-6 py-10 text-center">
          <Building2 size={28} className="mx-auto text-muted-foreground" />
          <p className="text-[13px] font-medium text-foreground mt-3">
            No live Claude Code sessions
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Start one anywhere on this machine and it appears here within a couple of
            seconds.
          </p>
        </Card>
      ) : (
        groups.map(({ projectKey, sessions }) => (
          <div key={projectKey} className="mb-4">
            <SectionLabel>{projectKey}</SectionLabel>
            <Card>
              {sessions.map((session) => (
                <Row
                  key={session.pid}
                  title={<span className="font-medium">{session.name}</span>}
                  subtitle={session.title ?? session.cwd}
                >
                  <StateBadge session={session} />
                </Row>
              ))}
            </Card>
          </div>
        ))
      )}
    </div>
  );
}
