import { describe, expect, it } from 'vitest';
import { groupSessions, statusColor, type PhoneProject, type PhoneSessionRow } from './grouping';

const projects: PhoneProject[] = [
  { id: 'shop', name: 'Shop', kind: 'site' },
  { id: 'blog', name: 'Blog', kind: 'site' },
  { id: 'empty', name: 'Empty', kind: 'folder' },
];

const session = (over: Partial<PhoneSessionRow> & { sessionId: string }): PhoneSessionRow => ({
  projectId: 'shop',
  agentId: 'claude',
  agentName: 'Claude Code',
  label: null,
  title: 'Working',
  state: 'working',
  unread: false,
  exited: false,
  exitCode: null,
  startedAt: 1,
  changedAt: 1,
  paneOf: null,
  hasTranscript: false,
  ...over,
});

describe('groupSessions', () => {
  it('puts Needs you first, then projects in order', () => {
    const groups = groupSessions(projects, [
      session({ sessionId: 'a', projectId: 'blog', state: 'working' }),
      session({ sessionId: 'b', projectId: 'shop', state: 'needs-input' }),
    ]);
    expect(groups[0].key).toBe('needs-you');
    expect(groups[0].sessions.map((s) => s.sessionId)).toEqual(['b']);
    expect(groups.slice(1).map((g) => g.key)).toEqual(['shop', 'blog', 'empty']);
  });

  it('sorts exited sessions last within a project', () => {
    const groups = groupSessions(projects, [
      session({ sessionId: 'old', changedAt: 1, exited: true, exitCode: 0, state: 'exited' }),
      session({ sessionId: 'new', changedAt: 9, state: 'working' }),
    ]);
    expect(groups[0].sessions.map((s) => s.sessionId)).toEqual(['new', 'old']);
  });

  it('keeps empty projects and parks unknown ones under Other', () => {
    const groups = groupSessions(projects, [session({ sessionId: 'x', projectId: 'gone' })]);
    expect(groups.find((g) => g.key === 'empty')?.sessions).toEqual([]);
    expect(groups.at(-1)?.key).toBe('other');
    expect(groups.at(-1)?.sessions.map((s) => s.sessionId)).toEqual(['x']);
  });

  it('omits the Needs you group when nothing needs input', () => {
    const groups = groupSessions(projects, [session({ sessionId: 'a' })]);
    expect(groups[0].key).toBe('shop');
  });
});

describe('statusColor', () => {
  it('matches the desktop meaning', () => {
    expect(statusColor('working')).toBe('#10b981');
    expect(statusColor('needs-input')).toBe('#f59e0b');
    expect(statusColor('error')).toBe('#ef4444');
  });
});
