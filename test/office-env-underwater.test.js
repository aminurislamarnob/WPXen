import { describe, expect, it } from 'vitest';
import {
  SEABED_Y,
  TOP_GAP,
  domeShape,
  insideDome,
  mayRiseAt,
  planSeabed,
  roomBox,
  schoolAnchor,
} from '../src/lib/office/scene/underwater.js';

// The Underwater environment's layout: the dome over the room, where each
// agent's fish school hovers, and what grows on the seabed. Its look is
// reviewed in the dev sandbox; these pin the rule that keeps the room
// visible — nothing above the floor between the camera and the room.

const ROOMS = [
  { minX: -2.4, maxX: 8.1, minZ: -3.4, maxZ: 5.5 }, // the smallest room
  { minX: -2.4, maxX: 20.6, minZ: -3.4, maxZ: 12.1 }, // a busy one
];

describe('underwater dome layout', () => {
  it('stands every corner of the room inside the dome', () => {
    for (const bounds of ROOMS) {
      const room = roomBox(bounds);
      const dome = domeShape(room);
      for (const [x, z] of [
        [room.x0, room.z0],
        [room.x1, room.z0],
        [room.x0, room.z1],
        [room.x1, room.z1],
      ])
        expect(insideDome(dome, x, 3.1, z)).toBe(true);
    }
  });

  it('puts every school outside the glass, behind or beside the room, above the floor', () => {
    for (const bounds of ROOMS) {
      const room = roomBox(bounds);
      const dome = domeShape(room);
      for (let x = room.x0 + 0.5; x < room.x1; x += 1.3)
        for (let z = room.z0 + 0.5; z < room.z1; z += 1.3)
          for (let slot = 0; slot < 12; slot++) {
            const a = schoolAnchor(dome, room, { x, z }, slot);
            expect(a.y).toBeGreaterThan(0);
            expect(mayRiseAt(room, a.x, a.z, 2.5)).toBe(true);
            expect(insideDome(dome, a.x, a.y, a.z)).toBe(false);
            // Moving outward (arrival, departure) only takes it further away.
            expect(mayRiseAt(room, a.x + a.out[0] * 30, a.z + a.out[1] * 30, 2.5)).toBe(
              true
            );
          }
    }
  });

  it('keeps the seabed on the camera side under the floor, and off the dome base', () => {
    for (const bounds of ROOMS) {
      const room = roomBox(bounds);
      const dome = domeShape(room);
      const { rocks, corals, kelp, vents } = planSeabed(room, dome, { seed: 9 });
      expect(rocks.length).toBeGreaterThan(20);
      expect(corals.length).toBeGreaterThan(40);
      expect(kelp.length).toBeGreaterThan(40);
      for (const item of [...rocks, ...corals, ...kelp]) {
        expect(insideDome(dome, item.x, SEABED_Y, item.z)).toBe(false);
        if (!mayRiseAt(room, item.x, item.z))
          expect(SEABED_Y + item.h).toBeLessThanOrEqual(-TOP_GAP);
      }
      for (const v of vents)
        if (!mayRiseAt(room, v.x, v.z)) expect(v.top).toBeLessThan(0);
      // The scenery behind the room is allowed to rise: tall kelp grows there.
      expect(kelp.some((k) => SEABED_Y + k.h > 2)).toBe(true);
    }
  });

  it('plans the same seabed for the same seed', () => {
    const room = roomBox(ROOMS[1]);
    const dome = domeShape(room);
    expect(planSeabed(room, dome, { seed: 3 })).toEqual(
      planSeabed(room, dome, { seed: 3 })
    );
  });
});
