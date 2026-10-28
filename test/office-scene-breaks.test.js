import { describe, expect, it } from 'vitest';
import {
  BreakAllocator,
  RALLY_PERIOD,
  rallyHit,
} from '../src/lib/office/scene/breaks.js';
import { createAllocators, planFloor } from '../src/lib/office/scene/layout.js';

// Break allocation is the pure seam behind commuting: on-break sessions get a
// sticky spot in the lounge, at the coffee bar or at the ping-pong table. The
// walk itself is reviewed via the dev Preview, not tested here.

function session(pid, extra = {}) {
  return {
    pid,
    sessionId: `s-${pid}`,
    cwd: '~/code/x',
    name: `x-${pid}`,
    state: 'idle',
    projectKey: 'x',
    startedAt: pid,
    feed: [],
    onBreak: true,
    ...extra,
  };
}

function spots() {
  const plan = planFloor(
    { sessions: { 1: session(1, { onBreak: false }) }, waitingCount: 0 },
    createAllocators()
  );
  return plan.amenities.spots;
}

describe('rallyHit', () => {
  it('peaks as the ball reaches each side, half a period apart', () => {
    const sample = (side) => {
      let best = 0;
      let at = 0;
      for (let t = 0; t < RALLY_PERIOD; t += RALLY_PERIOD / 360) {
        const v = rallyHit(t, side);
        if (v > best) {
          best = v;
          at = t;
        }
      }
      return { best, at };
    };
    const a = sample(0);
    const b = sample(1);
    expect(a.best).toBeGreaterThan(0.8);
    expect(b.best).toBeGreaterThan(0.8);
    const gap = Math.abs(a.at - b.at);
    expect(Math.min(gap, RALLY_PERIOD - gap)).toBeCloseTo(RALLY_PERIOD / 2, 1);
  });
});

describe('BreakAllocator', () => {
  it('assigns on-break sessions to distinct spots and keeps them sticky', () => {
    const alloc = new BreakAllocator();
    const sessions = [session(1), session(2), session(3)];
    const first = alloc.sync(sessions, spots());
    expect(first.size).toBe(3);
    expect(new Set([...first.values()].map((s) => s.id)).size).toBe(3);
    const again = alloc.sync(sessions, spots());
    for (const [pid, spot] of first) expect(again.get(pid).id).toBe(spot.id);
  });

  it('releases the spot when the break ends', () => {
    const alloc = new BreakAllocator();
    alloc.sync([session(1)], spots());
    const after = alloc.sync([session(1, { onBreak: false })], spots());
    expect(after.size).toBe(0);
  });

  it('gives a lone ping-pong player a partner before anything else', () => {
    const alloc = new BreakAllocator();
    const all = spots();
    // Find a session whose own preference is ping-pong, assign it first.
    let pp = null;
    for (let pid = 1; pid < 200 && !pp; pid++) {
      const probe = new BreakAllocator();
      const got = probe.sync([session(pid)], all);
      if (got.get(pid)?.activity === 'pingpong') pp = pid;
    }
    expect(pp).not.toBeNull();
    alloc.sync([session(pp)], all);
    // Whatever the next session would have preferred, it joins the table.
    const next = alloc.sync([session(pp), session(pp + 1000)], all);
    expect(next.get(pp + 1000).activity).toBe('pingpong');
    expect(next.get(pp + 1000).id).not.toBe(next.get(pp).id);
  });

  it('stops assigning when every spot is taken', () => {
    const alloc = new BreakAllocator();
    const all = spots();
    const many = Array.from({ length: all.length + 4 }, (_, i) => session(i + 1));
    const got = alloc.sync(many, all);
    expect(got.size).toBe(all.length);
  });
});
