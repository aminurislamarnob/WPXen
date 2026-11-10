// Projects & Sessions grouping for the phone list: the Needs-you group
// first (every needs-input Session, newest first), then one group per
// Project in sidebar order with live Sessions before exited ones. Pure, so
// vitest covers it with no React Native.

export interface PhoneSessionRow {
  sessionId: string;
  projectId: string;
  agentId: string;
  agentName: string;
  label: string | null;
  title: string;
  state: string;
  unread: boolean;
  exited: boolean;
  exitCode: number | null;
  startedAt: number;
  changedAt: number;
  paneOf: string | null;
  hasTranscript: boolean;
}

export interface PhoneProject {
  id: string;
  name: string;
  kind: string;
}

export interface SessionGroup {
  key: string;
  title: string;
  projectId: string | null;
  sessions: PhoneSessionRow[];
}

const byChangedDesc = (a: PhoneSessionRow, b: PhoneSessionRow) => b.changedAt - a.changedAt;

function orderGroup(sessions: PhoneSessionRow[]): PhoneSessionRow[] {
  const live = sessions.filter((s) => !s.exited).sort(byChangedDesc);
  const exited = sessions.filter((s) => s.exited).sort(byChangedDesc);
  return [...live, ...exited];
}

export function groupSessions(
  projects: PhoneProject[],
  sessions: PhoneSessionRow[]
): SessionGroup[] {
  const groups: SessionGroup[] = [];
  const needsYou = sessions.filter((s) => s.state === 'needs-input').sort(byChangedDesc);
  if (needsYou.length > 0) {
    groups.push({ key: 'needs-you', title: 'Needs you', projectId: null, sessions: needsYou });
  }
  const known = new Set(projects.map((p) => p.id));
  for (const project of projects) {
    groups.push({
      key: project.id,
      title: project.name,
      projectId: project.id,
      sessions: orderGroup(sessions.filter((s) => s.projectId === project.id)),
    });
  }
  const orphaned = sessions.filter((s) => !known.has(s.projectId));
  if (orphaned.length > 0) {
    groups.push({ key: 'other', title: 'Other', projectId: null, sessions: orderGroup(orphaned) });
  }
  return groups;
}

// The desktop's status meaning (CLAUDE.md tokens): working green,
// needs-input amber, error red, everything else quiet grey.
export function statusColor(state: string): string {
  if (state === 'working') return '#10b981';
  if (state === 'needs-input') return '#f59e0b';
  if (state === 'error') return '#ef4444';
  return '#8e8e93';
}
