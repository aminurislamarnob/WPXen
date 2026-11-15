import { describe, expect, it } from 'vitest';
import {
  BOAT_TOP,
  DECK_BOTTOM,
  MOORINGS,
  PIER_TOP,
  SEA_Y,
  islandLayout,
  islandScenery,
  mayRiseHere,
  rainDrops,
  sailIn,
  sailOut,
  shoreDistance,
  terrainHeight,
} from '../src/lib/office/scene/island.js';

// The tropical island around the Office room (scene/environments/Island.jsx).
// The look is reviewed in the dev sandbox; these pin the layout rules — above
// all that nothing rises above the office floor where it could come between
// the camera and the room.

const BOUNDS = { minX: -2, maxX: 17, minZ: -1, maxZ: 12 };
const layout = islandLayout(BOUNDS);

describe('office island environment', () => {
  it('keeps the beach under the deck and the water below the floor', () => {
    const { deck, c } = layout;
    for (let x = deck.x0; x <= deck.x1; x += 1)
      for (let z = deck.z0; z <= deck.z1; z += 1)
        expect(terrainHeight(x, z, c)).toBeLessThan(DECK_BOTTOM);
    for (let x = c.cx - 150; x <= c.cx + 150; x += 7)
      for (let z = c.cz - 150; z <= c.cz + 150; z += 7)
        expect(terrainHeight(x, z, c)).toBeLessThan(0);
  });

  it('puts the beach behind the room and the lagoon in front of it', () => {
    const { room, c } = layout;
    expect(shoreDistance(room.x0, room.z0, c)).toBeLessThan(0);
    expect(shoreDistance(room.x1 + 10, room.z1 + 10, c)).toBeGreaterThan(0);
  });

  it('gives every agent its own mooring beside the pier, low on the water', () => {
    const { moorings, pier, room } = layout;
    expect(moorings).toHaveLength(MOORINGS);
    // The first berths are along the deck's front edge, in view; the rest on the pier.
    expect(moorings[0].z).toBeGreaterThan(room.z1);
    for (let i = 0; i < moorings.length; i++) {
      const m = moorings[i];
      expect(m.x > room.x1 || m.z > room.z1).toBe(true);
      expect(m.x).toBeLessThan(pier.x1);
      for (let j = i + 1; j < moorings.length; j++)
        expect(Math.hypot(m.x - moorings[j].x, m.z - moorings[j].z)).toBeGreaterThan(2);
    }
    // Moored boats, pier lanterns and all, stay under the office floor.
    expect(SEA_Y + BOAT_TOP + 0.2).toBeLessThan(0);
    expect(PIER_TOP + 1).toBeLessThan(0);
  });

  it('sails a boat in from open sea to its mooring, and out again', () => {
    const m = layout.moorings[3];
    const start = sailIn(m, 0);
    const end = sailIn(m, 1);
    expect(Math.hypot(start.x - m.x, start.z - m.z)).toBeGreaterThan(50);
    expect(end.x).toBeCloseTo(m.x, 6);
    expect(end.z).toBeCloseTo(m.z, 6);
    expect(end.yaw).toBeCloseTo(0, 6); // berthed bow out to sea
    expect(sailOut(m, 0).x).toBeCloseTo(m.x, 6);
    expect(Math.hypot(sailOut(m, 1).x - m.x, sailOut(m, 1).z - m.z)).toBeGreaterThan(50);
    // The way in and out never crosses the room or its deck, for any berth.
    const { deck } = layout;
    const clear = (p) => p.x > deck.x1 || p.z > deck.z1 || p.x < deck.x0 || p.z < deck.z0;
    for (const berth of layout.moorings)
      for (let u = 0; u <= 1; u += 0.02) {
        expect(clear(sailIn(berth, u))).toBe(true);
        expect(clear(sailOut(berth, u))).toBe(true);
      }
  });

  it('only stands palms and hills where they may rise above the floor', () => {
    const { palms, hills, bushes } = islandScenery(layout, 5);
    expect(palms.length).toBeGreaterThan(12);
    for (const p of palms)
      expect(
        mayRiseHere(
          p.x - p.reach,
          p.x + p.reach,
          p.z - p.reach,
          p.z + p.reach,
          layout.room
        )
      ).toBe(true);
    for (const h of hills)
      expect(mayRiseHere(h.x - h.w, h.x + h.w, h.z - h.w, h.z + h.w, layout.room)).toBe(
        true
      );
    for (const b of bushes) {
      const rises = mayRiseHere(
        b.x - b.size,
        b.x + b.size,
        b.z - b.size,
        b.z + b.size,
        layout.room
      );
      if (!rises) expect(b.y + b.size * 0.9).toBeLessThan(0);
    }
  });

  it('is the same island for the same seed', () => {
    expect(islandScenery(layout, 5)).toEqual(islandScenery(layout, 5));
  });

  it('keeps the rain off the room and under the floor in front of it', () => {
    for (const [x, z, top, bottom] of rainDrops(layout, 400)) {
      expect(bottom).toBe(SEA_Y);
      const rises = mayRiseHere(x - 0.5, x + 0.5, z - 0.5, z + 0.5, layout.room);
      if (!rises) expect(top).toBeLessThan(0);
      const over =
        x > layout.room.x0 &&
        x < layout.room.x1 &&
        z > layout.room.z0 &&
        z < layout.room.z1;
      expect(over).toBe(false);
    }
  });
});
