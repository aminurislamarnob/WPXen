import { describe, expect, it } from 'vitest';
import {
  BLOOM_CAP,
  LAWN_Y,
  clearsView,
  flightEnd,
  flightPoint,
  itemBoxes,
  planGarden,
} from '../src/lib/office/scene/green.js';

// The Green view's garden. Its look is reviewed in the dev sandbox; these pin
// the layout rules — above all that nothing in the garden can hide the room.

const BOUNDS = { minX: -2, maxX: 17, minZ: -1, maxZ: 12 };
const SMALL = { minX: 0, maxX: 6, minZ: 0, maxZ: 5 };

/** Does the segment p → p + dir·len pass through the box (slab test)? */
function hits(p, dir, len, b) {
  let t0 = 0;
  let t1 = len;
  const axes = [
    [p.x, dir[0], b.x0, b.x1],
    [p.y, dir[1], -50, b.top],
    [p.z, dir[2], b.z0, b.z1],
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return false;
      continue;
    }
    let a = (lo - o) / d;
    let c = (hi - o) / d;
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, c);
    if (t0 > t1) return false;
  }
  return true;
}

describe('office green view garden', () => {
  it('plans the same garden for the same seed', () => {
    expect(planGarden(BOUNDS, { seed: 9 })).toEqual(planGarden(BOUNDS, { seed: 9 }));
  });

  for (const [label, bounds] of [
    ['a full room', BOUNDS],
    ['a small room', SMALL],
  ])
    it(`keeps every item clear of the camera's view of ${label}`, () => {
      const g = planGarden(bounds);
      for (const b of itemBoxes(g)) expect(clearsView(b, g.room), b.name).toBe(true);
    });

  it('casts the sight lines: no item crosses one, from any allowed camera angle', () => {
    const g = planGarden(BOUNDS);
    const boxes = itemBoxes(g);
    const { room } = g;
    const points = [];
    for (let i = 0; i <= 4; i++)
      for (let j = 0; j <= 4; j++)
        for (const y of [0.01, 1.5, 3.1])
          points.push({
            x: room.x0 + 0.05 + ((room.x1 - room.x0 - 0.1) * i) / 4,
            y,
            z: room.z0 + 0.05 + ((room.z1 - room.z0 - 0.1) * j) / 4,
          });
    // The OrbitControls limits: azimuth 0.12–1.45, polar 0.55–1.2.
    for (const az of [0.12, 0.5, 0.9, 1.45])
      for (const polar of [0.55, 0.9, 1.2]) {
        const dir = [
          Math.sin(polar) * Math.sin(az),
          Math.cos(polar),
          Math.sin(polar) * Math.cos(az),
        ];
        for (const p of points)
          for (const b of boxes) {
            if (hits(p, dir, 600, b))
              throw new Error(`${b.name} blocks the room at az ${az}`);
          }
      }
  });

  it('gives the birds a dozen or more perches behind or left of the room', () => {
    const g = planGarden(BOUNDS);
    expect(g.perches.length).toBeGreaterThanOrEqual(12);
    for (const p of g.perches)
      expect(p.z < g.room.z0 || p.x < g.room.x0, `${p.side} perch`).toBe(true);
  });

  it('has a spot for every bloom, inside a flower bed', () => {
    const g = planGarden(BOUNDS);
    expect(g.bloomSpots).toHaveLength(BLOOM_CAP);
    for (const f of g.bloomSpots)
      expect(
        g.beds.some((b) => f.x >= b.x0 && f.x <= b.x1 && f.z >= b.z0 && f.z <= b.z1)
      ).toBe(true);
  });

  it('stands the plinth on the lawn, right under the slab', () => {
    const g = planGarden(BOUNDS);
    const plinth = g.built[0];
    expect(plinth.y - plinth.h / 2).toBeCloseTo(LAWN_Y, 6);
    expect(plinth.y + plinth.h / 2).toBeCloseTo(-0.35, 6);
    expect(plinth.x - plinth.w / 2).toBeLessThan(g.room.x0);
    expect(plinth.x + plinth.w / 2).toBeGreaterThan(g.room.x1);
  });

  it('flies an arc that starts and ends on its ends and keeps to its side', () => {
    const g = planGarden(BOUNDS);
    for (const perch of g.perches) {
      const from = flightEnd(perch, 'in');
      expect(flightPoint(from, perch, 0)).toEqual({ x: from.x, y: from.y, z: from.z });
      expect(flightPoint(from, perch, 1)).toEqual({ x: perch.x, y: perch.y, z: perch.z });
      for (let u = 0; u <= 1; u += 0.1) {
        const p = flightPoint(from, perch, u);
        expect(p.z < g.room.z0 || p.x < g.room.x0).toBe(true);
      }
    }
    const mid = flightPoint({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 0.5, 4);
    expect(mid.y).toBeCloseTo(2, 6);
  });
});
