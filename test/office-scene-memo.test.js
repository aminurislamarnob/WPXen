import { describe, expect, it } from 'vitest';
import {
  activityEqual,
  characterPropsEqual,
  focusFor,
  pointsEqual,
  poseSignature,
  roomLayoutKey,
  sessionRenderEqual,
  spotEqual,
  workstationPropsEqual,
} from '../src/lib/office/scene/memo.js';
import { createAllocators, planFloor } from '../src/lib/office/scene/layout.js';

// The scene's React.memo boundaries. Snapshots arrive as fresh clones, so these
// value comparisons are the only thing standing between a transcript line and a
// full re-render of every desk; what they must NOT ignore is anything drawn.

const session = (over = {}) => ({
  pid: 1,
  sessionId: 's1',
  name: 'agent',
  title: 'Fix the thing',
  state: 'working',
  currentTool: 'Bash',
  onBreak: false,
  projectKey: 'wpxen',
  startedAt: 1,
  lastActivityAt: 5,
  feed: [{ id: 'a' }],
  subagents: {},
  ...over,
});

const clone = (v) => JSON.parse(JSON.stringify(v));

describe('sessionRenderEqual', () => {
  it('ignores fields the scene never draws', () => {
    const a = session();
    const b = clone({ ...a, feed: [{ id: 'b' }], lastActivityAt: 99, lastPrompt: 'x' });
    expect(sessionRenderEqual(a, b)).toBe(true);
  });

  it('notices every drawn field', () => {
    const a = session();
    for (const over of [
      { state: 'idle' },
      { currentTool: 'Read' },
      { title: 'Other' },
      { name: 'other' },
      { onBreak: true },
      { sessionId: 's2' },
      { subagents: { x: { subagentId: 'x', state: 'working', agentType: 'Explore' } } },
    ])
      expect(sessionRenderEqual(a, session(over)), JSON.stringify(over)).toBe(false);
  });

  it('compares subagents by drawn fields and seat order', () => {
    const x = { subagentId: 'x', state: 'working', agentType: 'Explore', feed: [] };
    const y = { subagentId: 'y', state: 'idle', agentType: 'Plan', feed: [] };
    const a = session({ subagents: { x, y } });
    expect(
      sessionRenderEqual(a, clone({ ...a, subagents: { x: { ...x, feed: [1] }, y } }))
    ).toBe(true);
    expect(sessionRenderEqual(a, session({ subagents: { y, x } }))).toBe(false);
    expect(
      sessionRenderEqual(
        a,
        session({ subagents: { x: { ...x, state: 'waiting_on_user' }, y } })
      )
    ).toBe(false);
    expect(
      sessionRenderEqual(
        a,
        session({ subagents: { x: { ...x, currentTool: 'Grep' }, y } })
      )
    ).toBe(false);
  });

  it('handles empty desks', () => {
    expect(sessionRenderEqual(null, null)).toBe(true);
    expect(sessionRenderEqual(null, session())).toBe(false);
  });
});

describe('routes, spots and activity', () => {
  it('compare by value', () => {
    expect(pointsEqual([{ x: 1, z: 2 }], [{ x: 1, z: 2 }])).toBe(true);
    expect(pointsEqual([{ x: 1, z: 2 }], [{ x: 1, z: 3 }])).toBe(false);
    expect(pointsEqual(null, null)).toBe(true);
    expect(pointsEqual(null, [])).toBe(false);

    const spot = { id: 'coffee-bar-0', activity: 'coffee', x: 1, z: 2, facing: 0.5 };
    expect(spotEqual(spot, clone(spot))).toBe(true);
    expect(spotEqual(spot, { ...spot, x: 1.5 })).toBe(false);
    expect(spotEqual(spot, null)).toBe(false);

    expect(
      activityEqual({ kind: 'pingpong', side: 1 }, { kind: 'pingpong', side: 1 })
    ).toBe(true);
    expect(
      activityEqual({ kind: 'pingpong', side: 1 }, { kind: 'pingpong', side: 0 })
    ).toBe(false);
    expect(activityEqual(undefined, undefined)).toBe(true);
  });
});

describe('focusFor', () => {
  it('only reports focus that concerns this session', () => {
    expect(focusFor(null, 1)).toBe(null);
    expect(focusFor({ pid: 2 }, 1)).toBe(null);
    expect(focusFor({ pid: 1 }, 1)).toBe('');
    expect(focusFor({ pid: 1, subagentId: 'x' }, 1)).toBe('x');
    expect(focusFor({ pid: 1 }, undefined)).toBe(null);
  });
});

describe('workstationPropsEqual', () => {
  const onSelect = () => {};
  const props = (over = {}) => ({
    session: session(),
    accent: '#f00',
    deskKey: '1',
    origin: { x: 1, z: 2, key: '1' },
    route: null,
    spot: null,
    focus: null,
    onSelect,
    ...over,
  });

  it('is equal across a snapshot that changes nothing drawn', () => {
    const a = props();
    const b = props({
      session: clone({ ...a.session, feed: [] }),
      origin: { x: 1, z: 2 },
    });
    expect(workstationPropsEqual(a, b)).toBe(true);
  });

  it('ignores focus moving between other agents', () => {
    expect(
      workstationPropsEqual(props({ focus: { pid: 7 } }), props({ focus: { pid: 8 } }))
    ).toBe(true);
    expect(workstationPropsEqual(props(), props({ focus: { pid: 1 } }))).toBe(false);
  });

  it('re-renders for state, a new route, a moved desk or a new handler', () => {
    expect(
      workstationPropsEqual(props(), props({ session: session({ state: 'idle' }) }))
    ).toBe(false);
    expect(workstationPropsEqual(props(), props({ route: [{ x: 0, z: 0 }] }))).toBe(
      false
    );
    expect(workstationPropsEqual(props(), props({ origin: { x: 3, z: 2 } }))).toBe(false);
    expect(workstationPropsEqual(props(), props({ onSelect: () => {} }))).toBe(false);
  });
});

describe('characterPropsEqual', () => {
  it('is shallow except for activity', () => {
    const base = {
      look: {},
      state: 'idle',
      stance: 'standing',
      activity: { kind: 'coffee' },
    };
    expect(characterPropsEqual(base, { ...base, activity: { kind: 'coffee' } })).toBe(
      true
    );
    expect(characterPropsEqual(base, { ...base, stance: 'walking' })).toBe(false);
    expect(characterPropsEqual(base, { ...base, look: {} })).toBe(false);
    expect(characterPropsEqual(base, { ...base, extra: 1 })).toBe(false);
  });
});

describe('roomLayoutKey and poseSignature', () => {
  const office = (sessions) => ({ sessions, waitingCount: 0 });
  const theme = { kind: 'claude' };

  it('room layout ignores everything but bounds and zones', () => {
    const alloc = createAllocators();
    const a = planFloor(office({ 1: session() }), alloc);
    const b = planFloor(office({ 1: session({ state: 'idle' }) }), alloc);
    expect(roomLayoutKey(a, theme)).toBe(roomLayoutKey(b, theme));
    expect(roomLayoutKey(a, theme)).not.toBe(roomLayoutKey(a, { kind: 'antigravity' }));
  });

  it('pose signature ignores tool and feed churn, but not pose changes', () => {
    const alloc = createAllocators();
    const sig = (s, breaks = new Map()) =>
      poseSignature(planFloor(office(s), alloc), breaks);
    const base = sig({ 1: session() });
    expect(sig({ 1: session({ currentTool: 'Read', feed: [] }) })).toBe(base);
    expect(sig({ 1: session({ state: 'thinking' }) })).not.toBe(base);
    expect(sig({ 1: session({ onBreak: true }) })).not.toBe(base);
    expect(sig({ 1: session() }, new Map([[1, { id: 'pingpong-0' }]]))).not.toBe(base);
    expect(
      sig({ 1: session({ subagents: { x: { subagentId: 'x', state: 'working' } } }) })
    ).not.toBe(base);
    expect(sig({ 1: session(), 2: session({ pid: 2, sessionId: 's2' }) })).not.toBe(base);
  });
});
