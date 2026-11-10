import { describe, expect, it } from 'vitest';
import {
  INSPECTOR_FEED_CAP,
  STATE_PRIORITY,
  agentList,
  inspectorView,
  stateBadge,
} from '../src/lib/office/hud.js';

function session(pid, state, extra = {}) {
  return {
    pid,
    sessionId: `s-${pid}`,
    cwd: '~/code/x',
    name: `x-${pid}`,
    state,
    projectKey: 'x',
    startedAt: pid,
    feed: [],
    subagents: {},
    ...extra,
  };
}

function intern(id, state, extra = {}) {
  return {
    subagentId: id,
    agentType: 'Explore',
    description: `survey ${id}`,
    toolUseId: `t-${id}`,
    state,
    ...extra,
  };
}

function office(...sessions) {
  return { sessions: Object.fromEntries(sessions.map((s) => [s.pid, s])) };
}

const pids = (group) => group.sessions.map((row) => row.session.pid);

describe('office agent list', () => {
  it('ranks waiting-on-you first, then error, working, thinking, idle, ended', () => {
    expect(
      Object.entries(STATE_PRIORITY)
        .sort((a, b) => a[1] - b[1])
        .map(([state]) => state)
    ).toEqual(['waiting_on_user', 'error', 'working', 'thinking', 'idle', 'ended']);
  });

  it('sorts sessions in a project by urgency, then by start time', () => {
    const list = agentList(
      office(
        session(1, 'idle'),
        session(2, 'working'),
        session(3, 'waiting_on_user'),
        session(4, 'working')
      )
    );
    expect(list).toHaveLength(1);
    expect(pids(list[0])).toEqual([3, 2, 4, 1]);
  });

  it('puts the project holding a waiting session first, ties broken by name', () => {
    const list = agentList(
      office(
        session(1, 'working', { projectKey: 'alpha' }),
        session(2, 'idle', { projectKey: 'beta' }),
        session(3, 'waiting_on_user', { projectKey: 'gamma' }),
        session(4, 'working', { projectKey: 'aardvark' })
      )
    );
    expect(list.map((g) => g.projectKey)).toEqual(['gamma', 'aardvark', 'alpha', 'beta']);
  });

  it('an intern waiting on you lifts its parent to the top, as the tab counts it', () => {
    const list = agentList(
      office(
        session(1, 'working', { projectKey: 'alpha' }),
        session(2, 'idle', {
          projectKey: 'beta',
          subagents: { a: intern('a', 'waiting_on_user') },
        })
      )
    );
    expect(list.map((g) => g.projectKey)).toEqual(['beta', 'alpha']);
  });

  it('lists interns under their parent, waiting first, otherwise in arrival order', () => {
    const [group] = agentList(
      office(
        session(1, 'working', {
          subagents: {
            a: intern('a', 'working'),
            b: intern('b', 'idle'),
            c: intern('c', 'waiting_on_user'),
            d: intern('d', 'working'),
          },
        })
      )
    );
    expect(group.sessions[0].interns.map((s) => s.subagentId)).toEqual([
      'c',
      'a',
      'd',
      'b',
    ]);
  });

  it('re-sorts live: a session that starts waiting moves up on the next snapshot', () => {
    const before = agentList(office(session(1, 'working'), session(2, 'working')));
    expect(pids(before[0])).toEqual([1, 2]);
    const after = agentList(office(session(1, 'working'), session(2, 'waiting_on_user')));
    expect(pids(after[0])).toEqual([2, 1]);
  });

  it('treats unknown states as least urgent and tolerates missing subagents', () => {
    const s = session(1, 'something-new');
    delete s.subagents;
    const [group] = agentList(office(session(2, 'ended'), s));
    expect(pids(group)).toEqual([2, 1]);
    expect(group.sessions[1].interns).toEqual([]);
  });

  it('is empty for an empty office', () => {
    expect(agentList({ sessions: {} })).toEqual([]);
  });
});

describe('office state badge', () => {
  it('maps every Agent State to a semantic tone and its label', () => {
    expect(stateBadge('waiting_on_user')).toMatchObject({
      label: 'Waiting on you',
      tone: 'warning',
    });
    expect(stateBadge('error')).toMatchObject({ label: 'Error', tone: 'error' });
    expect(stateBadge('idle')).toMatchObject({ label: 'Idle', tone: 'running' });
    expect(stateBadge('working')).toMatchObject({ label: 'Working', tone: 'highlight' });
    expect(stateBadge('thinking')).toMatchObject({
      label: 'Thinking',
      tone: 'highlight',
    });
    expect(stateBadge('ended')).toMatchObject({ label: 'Ended', tone: 'muted' });
  });

  it('shows the current tool only while working', () => {
    expect(stateBadge('working', { tool: 'Bash' }).tool).toBe('Bash');
    expect(stateBadge('thinking', { tool: 'Bash' }).tool).toBeUndefined();
  });

  it('an idle agent on break reads "On break"', () => {
    expect(stateBadge('idle', { onBreak: true }).label).toBe('On break');
    expect(stateBadge('error', { onBreak: true }).label).toBe('Error');
  });

  it('falls back to a muted badge for a state this version does not know', () => {
    expect(stateBadge('mystery')).toMatchObject({ label: 'mystery', tone: 'muted' });
  });
});

describe('office inspector view', () => {
  const feed = Array.from({ length: 30 }, (_, i) => ({
    id: `e${i}`,
    role: i % 2 ? 'assistant' : 'user',
    type: ['text', 'tool_use', 'tool_result', 'error'][i % 4],
    excerpt: `event ${i}`,
  }));

  const base = session(7, 'working', {
    title: 'Fix the importer',
    projectKey: 'shop',
    gitBranch: 'feat/import',
    currentTool: 'Edit',
    lastPrompt: 'Make the importer resumable.',
    feed,
    subagents: {
      a: intern('a', 'idle'),
      b: intern('b', 'waiting_on_user', { currentTool: 'Bash' }),
    },
  });

  it('carries the session header: title, name, project, branch, last prompt', () => {
    const view = inspectorView(base);
    expect(view).toMatchObject({
      pid: 7,
      title: 'Fix the importer',
      name: 'x-7',
      projectKey: 'shop',
      gitBranch: 'feat/import',
      lastPrompt: 'Make the importer resumable.',
    });
  });

  it('uses the session name as the title when the transcript has none yet', () => {
    const view = inspectorView(session(1, 'idle'));
    expect(view.title).toBe('x-1');
    expect(view.name).toBeUndefined();
  });

  it('badges the session state with its current tool', () => {
    expect(inspectorView(base).badge).toEqual({
      label: 'Working',
      tone: 'highlight',
      tool: 'Edit',
    });
  });

  it('keeps the newest entries of the feed, capped, labelled by kind', () => {
    const view = inspectorView(base);
    expect(view.feed).toHaveLength(INSPECTOR_FEED_CAP);
    expect(view.feed.at(-1)).toMatchObject({ id: 'e29', excerpt: 'event 29' });
    // e26..e29 cycle through the four feed kinds
    expect(view.feed.map((e) => e.label).slice(-4)).toEqual([
      'Result',
      'Error',
      'Message',
      'Tool call',
    ]);
  });

  it('copes with a session that has no feed yet', () => {
    const s = session(1, 'idle');
    delete s.feed;
    expect(inspectorView(s).feed).toEqual([]);
  });

  it('lists interns waiting first with their badges', () => {
    const view = inspectorView(base);
    expect(view.interns.map((i) => i.subagentId)).toEqual(['b', 'a']);
    expect(view.interns[0]).toMatchObject({
      agentType: 'Explore',
      description: 'survey b',
      badge: { label: 'Waiting on you', tone: 'warning' },
    });
  });

  it('describes the focused intern, or none when focus is on the session', () => {
    expect(inspectorView(base).intern).toBeNull();
    expect(inspectorView(base, 'b').intern).toMatchObject({
      subagentId: 'b',
      badge: { tone: 'warning' },
    });
    expect(inspectorView(base, 'gone').intern).toBeNull();
  });
});
