import { describe, expect, it } from 'vitest';
import {
  DECK_DEPTH,
  NEON,
  SIGN_W,
  allowedAbove,
  deckPieces,
  dockSlots,
  lightningDark,
  lightningFlash,
  neonFor,
  rainDrops,
  roomBox,
  signSlots,
  trafficLanes,
} from '../src/lib/office/scene/cyberpunk.js';

// The neon rooftop's layout. The world itself is reviewed in the dev sandbox;
// these pin the rule that keeps the room visible — nothing above the office
// floor except behind the back wall or beyond the left wall, never past the
// room's open sides — plus the placements and the lightning curves.

const BOUNDS = { minX: -2.6, maxX: 17, minZ: -3.4, maxZ: 12 };
const room = roomBox(BOUNDS);

describe('neon rooftop layout', () => {
  it('only allows scenery above the floor behind or left of the room', () => {
    expect(allowedAbove(5, room.minZ - 1, room)).toBe(true); // behind
    expect(allowedAbove(room.minX - 1, 5, room)).toBe(true); // left
    expect(allowedAbove(room.minX - 5, room.minZ - 5, room)).toBe(true); // back-left
    expect(allowedAbove(5, 5, room)).toBe(false); // over the room
    expect(allowedAbove(room.x1 + 1, room.minZ - 5, room)).toBe(false); // back-right
    expect(allowedAbove(room.minX - 5, room.z1 + 1, room)).toBe(false); // front-left
    expect(allowedAbove(room.x1 + 3, 5, room)).toBe(false); // right
  });

  it('stands signs on the wall tops, back wall first, inside the room span', () => {
    const signs = signSlots(BOUNDS);
    expect(signs.length).toBeGreaterThanOrEqual(4);
    const back = signs.filter((s) => s.yaw === 0);
    const left = signs.filter((s) => s.yaw !== 0);
    expect(signs.slice(0, back.length)).toEqual(back);
    for (const s of back) {
      expect(s.z).toBeLessThan(room.minZ);
      expect(s.x - SIGN_W / 2).toBeGreaterThanOrEqual(room.x0);
      expect(s.x + SIGN_W / 2).toBeLessThanOrEqual(room.x1);
    }
    for (const s of left) {
      expect(s.x).toBeLessThan(room.minX);
      expect(s.z - SIGN_W / 2).toBeGreaterThanOrEqual(room.z0);
      expect(s.z + SIGN_W / 2).toBeLessThanOrEqual(room.z1);
    }
    for (const s of signs) expect(s.y).toBeGreaterThan(3.1); // above the wall
  });

  it('puts every dock on the terrace, behind or left of the room', () => {
    const docks = dockSlots(BOUNDS);
    expect(docks.length).toBeGreaterThanOrEqual(8);
    for (const d of docks) {
      expect(allowedAbove(d.x, d.z, room)).toBe(true);
      expect(d.x).toBeGreaterThan(room.x0 - DECK_DEPTH);
      expect(d.z).toBeGreaterThan(room.z0 - DECK_DEPTH);
      // A car flies off away from the room.
      expect(d.out[0]).toBeLessThan(0);
      expect(d.out[1]).toBeLessThan(0);
    }
  });

  it('lays the terrace at floor level, never over the room', () => {
    for (const p of deckPieces(BOUNDS)) {
      expect(p.y + p.h / 2).toBeLessThanOrEqual(0);
      // Touching the room's edge is fine; overlapping it is not.
      const e = 1e-9;
      const inside =
        p.x - p.w / 2 < room.x1 - e &&
        p.x + p.w / 2 > room.x0 + e &&
        p.z - p.d / 2 < room.z1 - e &&
        p.z + p.d / 2 > room.z0 + e;
      expect(inside).toBe(false);
    }
  });

  it('keeps high traffic behind or left, and everything else below the floor', () => {
    for (const lane of trafficLanes(BOUNDS)) {
      const dx = Math.cos(lane.yaw) * (lane.len / 2);
      const dz = -Math.sin(lane.yaw) * (lane.len / 2);
      const ends = [
        [lane.x - dx, lane.z - dz],
        [lane.x + dx, lane.z + dz],
      ];
      if (lane.y > 0)
        // Both ends (with a car's half-length of slack at the room edge).
        for (const [x, z] of ends)
          expect(allowedAbove(x - 1.2, z - 1.2, room)).toBe(true);
      else expect(lane.y).toBeLessThanOrEqual(-5);
    }
  });

  it('never rains over the room or in front of it above the floor', () => {
    const drops = rainDrops(BOUNDS, 1500);
    expect(drops).toHaveLength(1500);
    for (const d of drops)
      if (d.top > 0) expect(allowedAbove(d.x, d.z, room)).toBe(true);
      else expect(d.top).toBeLessThan(0);
  });

  it('flashes lightning in strokes and then goes dark for a moment', () => {
    expect(lightningFlash(-0.1)).toBe(0);
    expect(lightningFlash(0)).toBeGreaterThan(0.5);
    expect(lightningFlash(0.16)).toBeGreaterThan(0.9);
    expect(lightningFlash(0.12)).toBe(0); // between strokes
    expect(lightningFlash(1.5)).toBe(0);
    expect(lightningDark(0.2)).toBe(0);
    expect(Math.max(...[0.6, 0.65, 0.7, 0.75].map(lightningDark))).toBeGreaterThan(0.5);
    expect(lightningDark(3)).toBe(0);
  });

  it('gives each project a stable neon colour from the palette', () => {
    expect(neonFor('storefront')).toBe(neonFor('storefront'));
    expect(NEON).toContain(neonFor('agent-verse'));
    const spread = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(neonFor));
    expect(spread.size).toBeGreaterThan(2);
  });
});
