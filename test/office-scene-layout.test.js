import { describe, expect, it } from 'vitest';
import {
  DESK_PITCH,
  DESKS_PER_ROW,
  SlotAllocator,
  createAllocators,
  internBench,
  planFloor,
  routeToBreak,
} from '../src/lib/office/scene/layout.js';

// Floor-plan math is the pure seam behind the 3D scene: pods per project,
// sticky desk slots per session, the amenity strip and break routes. The
// rendering of this plan is reviewed via the dev Preview, not tested here.

function session(pid, projectKey, startedAt, extra = {}) {
  return {
    pid,
    sessionId: `s-${pid}`,
    cwd: `~/code/${projectKey}`,
    name: `${projectKey}-${pid}`,
    state: 'working',
    projectKey,
    startedAt,
    feed: [],
    ...extra,
  };
}

function office(...sessions) {
  return {
    sessions: Object.fromEntries(sessions.map((s) => [s.pid, s])),
    waitingCount: 0,
  };
}

describe('SlotAllocator', () => {
  it('keeps a key on its slot for as long as it lives', () => {
    const a = new SlotAllocator();
    expect([...a.sync(['x', 'y'])]).toEqual([
      ['x', 0],
      ['y', 1],
    ]);
    // y stays put even when x leaves.
    expect(a.sync(['y']).get('y')).toBe(1);
  });

  it('reuses freed slots lowest-first', () => {
    const a = new SlotAllocator();
    a.sync(['x', 'y', 'z']);
    a.sync(['y', 'z']);
    expect(a.sync(['y', 'z', 'w']).get('w')).toBe(0);
  });
});

describe('planFloor', () => {
  it('lays pods out alphabetically on a fresh load', () => {
    const plan = planFloor(
      office(session(1, 'zeta', 1), session(2, 'alpha', 2)),
      createAllocators()
    );
    expect(plan.pods.map((p) => p.projectKey)).toEqual(['alpha', 'zeta']);
    const [alpha, zeta] = plan.pods;
    expect(alpha.x).toBe(0);
    expect(zeta.x).toBeGreaterThan(alpha.x); // next pod column to the right
    expect(zeta.z).toBe(alpha.z); // same grid row
  });

  it('keeps a pod in its slot when an earlier project leaves', () => {
    const alloc = createAllocators();
    planFloor(office(session(1, 'alpha', 1), session(2, 'beta', 2)), alloc);
    const plan = planFloor(office(session(2, 'beta', 2)), alloc);
    expect(plan.pods[0].projectKey).toBe('beta');
    expect(plan.pods[0].x).toBeGreaterThan(0); // still in column 1
  });

  it('orders desks by startedAt and pitches them along the row', () => {
    const plan = planFloor(
      office(session(5, 'alpha', 50), session(3, 'alpha', 10)),
      createAllocators()
    );
    const occupied = plan.pods[0].desks.filter((d) => d.session);
    expect(occupied.map((d) => d.session.pid)).toEqual([3, 5]);
    expect(occupied[1].x - occupied[0].x).toBeCloseTo(DESK_PITCH);
    expect(occupied[1].z).toBe(occupied[0].z);
  });

  it('adds one spare hot desk unless the row is exactly full', () => {
    const two = planFloor(
      office(session(1, 'alpha', 1), session(2, 'alpha', 2)),
      createAllocators()
    );
    expect(two.pods[0].desks).toHaveLength(3);
    expect(two.pods[0].desks[2].session).toBeNull();

    const three = planFloor(
      office(session(1, 'alpha', 1), session(2, 'alpha', 2), session(3, 'alpha', 3)),
      createAllocators()
    );
    expect(three.pods[0].desks).toHaveLength(DESKS_PER_ROW);
    expect(three.pods[0].desks.every((d) => d.session)).toBe(true);
  });

  it('turns leftover row slots into nooks', () => {
    const plan = planFloor(office(session(1, 'alpha', 1)), createAllocators());
    // 1 session + 1 hot desk = 2 desks, 1 nook completes the row of three.
    expect(plan.pods[0].desks).toHaveLength(2);
    expect(plan.pods[0].nooks).toHaveLength(1);
  });

  it('a desk keeps its position when an earlier session of the pod ends', () => {
    const alloc = createAllocators();
    const before = planFloor(
      office(session(1, 'alpha', 1), session(2, 'alpha', 2)),
      alloc
    );
    const deskOf2 = before.pods[0].desks.find((d) => d.session?.pid === 2);
    const after = planFloor(office(session(2, 'alpha', 2)), alloc);
    const still2 = after.pods[0].desks.find((d) => d.session?.pid === 2);
    expect(still2.x).toBe(deskOf2.x);
    expect(still2.z).toBe(deskOf2.z);
  });

  it('bounds include the amenity strips and a minimum room width', () => {
    const plan = planFloor(office(session(1, 'alpha', 1)), createAllocators());
    expect(plan.minX).toBe(-2.4);
    expect(plan.minZ).toBe(-3.4);
    expect(plan.maxX).toBe(9.1); // MIN_ROOM_X beats one pod column
    expect(plan.maxZ).toBeGreaterThanOrEqual(5.5);
  });

  it('drops back-wall zones right-to-left when the room is narrow', () => {
    const narrow = planFloor(office(session(1, 'alpha', 1)), createAllocators());
    expect(narrow.amenities.zones.map((z) => z.kind)).toEqual([
      'lounge',
      'coffee',
      'play',
    ]);

    const sessions = [];
    let pid = 1;
    for (const key of ['alpha', 'beta', 'gamma']) sessions.push(session(pid, key, pid++));
    const wide = planFloor(office(...sessions), createAllocators());
    expect(wide.amenities.zones.map((z) => z.kind)).toEqual([
      'lounge',
      'coffee',
      'play',
      'screen',
      'neon',
      'arcade',
    ]);
  });

  it('amenities provide break spots for ping-pong, coffee and lounge', () => {
    const plan = planFloor(office(session(1, 'alpha', 1)), createAllocators());
    const byActivity = new Map();
    for (const s of plan.amenities.spots)
      byActivity.set(s.activity, (byActivity.get(s.activity) ?? 0) + 1);
    expect(byActivity.get('pingpong')).toBe(2);
    expect(byActivity.get('coffee')).toBe(5);
    expect(byActivity.get('lounge')).toBe(5);
    // Ids are unique (BreakAllocator keys on them).
    expect(new Set(plan.amenities.spots.map((s) => s.id)).size).toBe(
      plan.amenities.spots.length
    );
  });
});

describe('routeToBreak', () => {
  it('walks desk → behind the chairs → pod aisle → corridor → spot', () => {
    const plan = planFloor(office(session(1, 'alpha', 1)), createAllocators());
    const desk = plan.pods[0].desks[0];
    const spot = plan.amenities.spots.find((s) => s.id === 'pingpong-0');
    const route = routeToBreak(
      plan,
      { x: desk.x, z: desk.z, podX: plan.pods[0].x },
      spot
    );
    expect(route[0]).toEqual({ x: desk.x, z: desk.z - 0.08 });
    expect(route.at(-1)).toEqual({ x: spot.x, z: spot.z });
    // The corridor leg runs in front of the amenity strip.
    expect(route.some((p) => p.z === plan.amenities.corridorZ)).toBe(true);
  });

  it('inserts the spot waypoints for seats tucked behind furniture', () => {
    const plan = planFloor(office(session(1, 'alpha', 1)), createAllocators());
    const sofa = plan.amenities.spots.find((s) => s.id === 'lounge-sofa-0');
    const desk = plan.pods[0].desks[0];
    const route = routeToBreak(
      plan,
      { x: desk.x, z: desk.z, podX: plan.pods[0].x },
      sofa
    );
    for (const via of sofa.via) expect(route).toContainEqual(via);
  });
});

describe('internBench', () => {
  const sub = (id) => ({ subagentId: id, agentType: 'Agent', state: 'working' });

  it('pulls up a chair per subagent at the source seat positions', () => {
    const { seated, overflow } = internBench({ a: sub('a'), b: sub('b') });
    expect(overflow).toBe(0);
    expect(seated.map((s) => s.sub.subagentId)).toEqual(['a', 'b']);
    // Source seating: a row in front of the desk, 0.55 apart from x = -0.5,
    // each stool at z = 1.42 angled -0.25 toward the parent.
    expect(seated[0]).toMatchObject({ x: -0.5, z: 1.42, yaw: -0.25 });
    expect(seated[1]).toMatchObject({ x: -0.5 + 0.55, z: 1.42, yaw: -0.25 });
  });

  it('seats at most three and counts the rest as overflow', () => {
    const { seated, overflow } = internBench({
      a: sub('a'),
      b: sub('b'),
      c: sub('c'),
      d: sub('d'),
      e: sub('e'),
    });
    expect(seated).toHaveLength(3);
    expect(seated.map((s) => s.sub.subagentId)).toEqual(['a', 'b', 'c']);
    expect(overflow).toBe(2);
  });

  it('handles a session with no subagents map', () => {
    expect(internBench(undefined)).toEqual({ seated: [], overflow: 0 });
  });
});
