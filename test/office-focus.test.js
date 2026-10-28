import { describe, expect, it } from 'vitest';
import { focusKey, focusTarget, reconcileFocus } from '../src/lib/office/focus.js';
import { createAllocators, planFloor } from '../src/lib/office/scene/layout.js';

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

function intern(id, state = 'working') {
  return { subagentId: id, agentType: 'Explore', description: '', toolUseId: id, state };
}

function office(...sessions) {
  return { sessions: Object.fromEntries(sessions.map((s) => [s.pid, s])) };
}

describe('office focus reconciliation', () => {
  const o = office(session(1, 'working', { subagents: { a: intern('a') } }));

  it('keeps no focus as no focus', () => {
    expect(reconcileFocus(o, null)).toBeNull();
  });

  it('returns the same focus while its session (and intern) are still present', () => {
    const f = { pid: 1 };
    expect(reconcileFocus(o, f)).toBe(f);
    const g = { pid: 1, subagentId: 'a' };
    expect(reconcileFocus(o, g)).toBe(g);
  });

  it('clears focus when the focused session leaves the office', () => {
    expect(reconcileFocus(office(), { pid: 1 })).toBeNull();
    expect(reconcileFocus(office(), { pid: 1, subagentId: 'a' })).toBeNull();
  });

  it('falls back to the parent session when the focused intern finishes', () => {
    const later = office(session(1, 'working'));
    expect(reconcileFocus(later, { pid: 1, subagentId: 'a' })).toEqual({ pid: 1 });
  });
});

describe('office focus target', () => {
  const sessions = office(
    session(1, 'working', {
      subagents: {
        a: intern('a'),
        b: intern('b'),
        c: intern('c'),
        d: intern('d'),
      },
    }),
    session(2, 'idle', { onBreak: true })
  );
  const plan = planFloor(sessions, createAllocators());
  const desk = (pid) =>
    plan.pods.flatMap((p) => p.desks).find((d) => d.session?.pid === pid);

  it('has no target without focus or for a session not on the floor', () => {
    expect(focusTarget(plan, null, new Map())).toBeNull();
    expect(focusTarget(plan, { pid: 99 }, new Map())).toBeNull();
  });

  it('aims at the desk of a focused session', () => {
    const d = desk(1);
    expect(focusTarget(plan, { pid: 1 }, new Map())).toEqual({ x: d.x, y: 1, z: d.z });
  });

  it('aims at an on-break session where it is taking its break', () => {
    const spot = { id: 'coffee-0', x: 3, z: -2 };
    const breaks = new Map([[2, spot]]);
    expect(focusTarget(plan, { pid: 2 }, breaks)).toEqual({ x: 3, y: 1, z: -2 });
  });

  it('aims at an intern on its stool in front of the parent desk', () => {
    const d = desk(1);
    const t = focusTarget(plan, { pid: 1, subagentId: 'b' }, new Map());
    expect(t.x).toBeCloseTo(d.x - 0.5 + 0.55);
    expect(t.y).toBeCloseTo(0.8);
    expect(t.z).toBeCloseTo(d.z + 1.42);
  });

  it('an intern without a stool (overflow) is framed at the parent desk', () => {
    const d = desk(1);
    expect(focusTarget(plan, { pid: 1, subagentId: 'd' }, new Map())).toEqual({
      x: d.x,
      y: 1,
      z: d.z,
    });
  });

  it('an intern is framed at the desk even while its parent is on break', () => {
    const spot = { id: 'coffee-0', x: 3, z: -2 };
    const t = focusTarget(plan, { pid: 1, subagentId: 'a' }, new Map([[1, spot]]));
    expect(t.z).toBeCloseTo(desk(1).z + 1.42);
  });
});

describe('office focus key', () => {
  it('is empty without focus', () => {
    expect(focusKey(null, new Map())).toBe('');
  });

  it('changes with the session, the intern, and the break spot', () => {
    const none = new Map();
    const onBreak = new Map([[1, { id: 'coffee-0' }]]);
    const keys = new Set([
      focusKey({ pid: 1 }, none),
      focusKey({ pid: 2 }, none),
      focusKey({ pid: 1, subagentId: 'a' }, none),
      focusKey({ pid: 1 }, onBreak),
    ]);
    expect(keys.size).toBe(4);
    expect(focusKey({ pid: 1 }, none)).toBe(focusKey({ pid: 1 }, new Map()));
  });
});
