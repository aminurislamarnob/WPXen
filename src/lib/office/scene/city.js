// ── City ─────────────────────────────────────────────────────
// The Office is one floor of a tower; this plans the city it stands in: the
// tower itself, the street grid far below, and a building on every lot around
// it. Pure and seeded, so the same room always stands in the same city.
//
// ⚠️ The one rule the layout must keep: nothing may come between the camera
// and the room. The camera only ever looks from the +x/+z quadrant (the
// OrbitControls azimuth range), downwards. A building whose roof is below the
// office floor can never cover the room from there — both its height and its
// distance push it down the screen — so only lots entirely behind the back wall
// (−z) or beside the left wall (−x), and not reaching past the room's open
// sides, may rise above it. Everywhere else roofs stay at least LOW_ROOF_GAP
// below the floor. Tested in office-scene-city.test.js.

/** Storey height of the tower, in scene units (metres). */
export const FLOOR_H = 3.6;
/** Storeys between the street and the office floor. */
export const FLOORS_BELOW = 17;
/** Street level, relative to the office floor at y = 0. */
export const STREET_Y = -FLOORS_BELOW * FLOOR_H;
/** Bottom of the office's floor slab: where the tower body below begins. */
export const SLAB_DEPTH = 0.35;
/** How far below the office floor the roofs on the camera's side must stay. */
export const LOW_ROOF_GAP = 4;

/** A city block between roads. */
const BLOCK = 22;
/** Road width between blocks. */
const ROAD = 11;
/** Plaza around the office tower's own footprint. */
const PLAZA = 6;
/**
 * Lots this close to the tower's block stay well below the office floor
 * whichever side they're on, so the office has open air around it and reads
 * as high up rather than wedged between neighbours.
 */
const NEAR_RING = 34;
/** Past this distance the skyline behind the office may hold landmark towers. */
const FAR_RING = 75;
/** Gap between neighbouring buildings on one block. */
const ALLEY = 1.4;
/** Pavement between a building and its block's kerb. */
const SETBACK = 0.9;
/** Share of blocks left as parks. */
const PARK_SHARE = 0.12;

/**
 * Facade tints: glass, concrete, stone and brick, picked per building.
 * Index 0 is reserved for the office tower.
 */
export const TINTS = [
  '#a9bccb', // the office tower: pale blue glass
  '#8fa6ba',
  '#6f8296',
  '#b7b2a8',
  '#cfc6b6',
  '#9b8f80',
  '#a77f6a',
  '#5f6b78',
  '#c4cdd4',
  '#7d8c7e',
];

/** Deterministic PRNG (mulberry32): the same seed always plans the same city. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Edges of the blocks along one axis, outward from the tower's own block
 * `[lo, hi]` until `limit` away from `center`: alternating road, block.
 * @returns {Array<[number, number]>} block spans, the tower's included.
 */
function spans(lo, hi, center, limit) {
  const out = [[lo, hi]];
  for (let x = lo - ROAD; x - BLOCK > center - limit; x -= ROAD + BLOCK)
    out.unshift([x - BLOCK, x]);
  for (let x = hi + ROAD; x + BLOCK < center + limit; x += ROAD + BLOCK)
    out.push([x, x + BLOCK]);
  return out;
}

/**
 * Splits a block into one, two or four lots.
 * @param {{ x0: number, x1: number, z0: number, z1: number }} b
 * @param {() => number} rand
 */
function lots(b, rand) {
  const r = rand();
  const mx = (b.x0 + b.x1) / 2 + (rand() - 0.5) * 4;
  const mz = (b.z0 + b.z1) / 2 + (rand() - 0.5) * 4;
  const g = ALLEY / 2;
  if (r < 0.25) return [b];
  if (r < 0.45)
    return [
      { ...b, x1: mx - g },
      { ...b, x0: mx + g },
    ];
  if (r < 0.65)
    return [
      { ...b, z1: mz - g },
      { ...b, z0: mz + g },
    ];
  return [
    { x0: b.x0, x1: mx - g, z0: b.z0, z1: mz - g },
    { x0: mx + g, x1: b.x1, z0: b.z0, z1: mz - g },
    { x0: b.x0, x1: mx - g, z0: mz + g, z1: b.z1 },
    { x0: mx + g, x1: b.x1, z0: mz + g, z1: b.z1 },
  ];
}

/**
 * Whether a lot may rise above the office floor: entirely behind the tower's
 * block and not past its right edge, or entirely left of it and not past its
 * front edge (see the rule at the top of this file).
 * @param {{ x0: number, x1: number, z0: number, z1: number }} lot
 * @param {{ x0: number, x1: number, z0: number, z1: number }} tower
 */
export function mayRise(lot, tower) {
  return (
    (lot.z1 <= tower.z0 && lot.x1 <= tower.x1) ||
    (lot.x1 <= tower.x0 && lot.z1 <= tower.z1)
  );
}

/**
 * @typedef {object} Building
 * @property {number} x  Footprint centre.
 * @property {number} z
 * @property {number} w  Footprint width (x) and depth (z).
 * @property {number} d
 * @property {number} base Street level, or the tower's.
 * @property {number} top  Roof height.
 * @property {number} tint Index into TINTS.
 * @property {number} seed 0..1, varies the window pattern.
 */

/**
 * The city around a room.
 * @param {{ minX: number, maxX: number, minZ: number, maxZ: number }} bounds
 *   The room's floor plan bounds (plan.maxX/maxZ are the last cell, so the
 *   room's far edges are maxX + 1 / maxZ + 1).
 * @param {{ seed?: number, radius?: number, wall?: number }} [opts]
 */
export function planCity(bounds, { seed = 1, radius = 170, wall = 0.14 } = {}) {
  const rand = rng(seed);
  const room = {
    x0: bounds.minX - wall,
    x1: bounds.maxX + 1,
    z0: bounds.minZ - wall,
    z1: bounds.maxZ + 1,
  };
  const block = {
    x0: room.x0 - PLAZA,
    x1: room.x1 + PLAZA,
    z0: room.z0 - PLAZA,
    z1: room.z1 + PLAZA,
  };
  const cx = (room.x0 + room.x1) / 2;
  const cz = (room.z0 + room.z1) / 2;

  /** @type {Building[]} */
  const buildings = [
    {
      x: cx,
      z: cz,
      w: room.x1 - room.x0 - 0.06,
      d: room.z1 - room.z0 - 0.06,
      base: STREET_Y,
      top: -SLAB_DEPTH,
      tint: 0,
      seed: 0.37,
    },
  ];
  /** @type {Array<{ x0: number, x1: number, z0: number, z1: number, park: boolean }>} */
  const blocks = [{ ...block, park: false }];
  /** Rooftop plant: cooling units and water tanks. */
  const roofUnits = [];
  /** Park and street trees: a crown position and size each. */
  const trees = [];
  /** Distance from a lot to the tower's block, 0 when touching it. */
  const gapTo = (lot) =>
    Math.hypot(
      Math.max(block.x0 - lot.x1, lot.x0 - block.x1, 0),
      Math.max(block.z0 - lot.z1, lot.z0 - block.z1, 0)
    );
  /** A row of street trees along one kerb of a block. */
  const lineKerb = (x0, z0, x1, z1) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    for (let t = 2.5; t < len - 2; t += 5 + rand() * 2)
      trees.push({
        x: x0 + ((x1 - x0) * t) / len,
        z: z0 + ((z1 - z0) * t) / len,
        r: 1.1 + rand() * 0.5,
      });
  };
  // The tower's own plaza is planted on its two open (camera) sides.
  lineKerb(block.x0 + 1.2, block.z1 - 1.2, block.x1 - 1.2, block.z1 - 1.2);
  lineKerb(block.x1 - 1.2, block.z0 + 1.2, block.x1 - 1.2, block.z1 - 1.2);

  for (const [x0, x1] of spans(block.x0, block.x1, cx, radius))
    for (const [z0, z1] of spans(block.z0, block.z1, cz, radius)) {
      if (x0 === block.x0 && z0 === block.z0) continue; // the office's own block
      const bx = (x0 + x1) / 2;
      const bz = (z0 + z1) / 2;
      if (Math.hypot(bx - cx, bz - cz) > radius) continue;
      const park = rand() < PARK_SHARE;
      blocks.push({ x0, x1, z0, z1, park });
      if (!park && rand() < 0.45) {
        lineKerb(x0 + 0.8, z1 - 0.8, x1 - 0.8, z1 - 0.8);
        lineKerb(x1 - 0.8, z0 + 0.8, x1 - 0.8, z1 - 0.8);
      }
      if (park) {
        const n = 5 + Math.floor(rand() * 6);
        for (let i = 0; i < n; i++)
          trees.push({
            x: x0 + 2 + rand() * (x1 - x0 - 4),
            z: z0 + 2 + rand() * (z1 - z0 - 4),
            r: 1.4 + rand() * 1.4,
          });
        continue;
      }
      for (const lot of lots({ x0, x1, z0, z1 }, rand)) {
        const fx0 = lot.x0 + SETBACK;
        const fx1 = lot.x1 - SETBACK;
        const fz0 = lot.z0 + SETBACK;
        const fz1 = lot.z1 - SETBACK;
        if (fx1 - fx0 < 3 || fz1 - fz0 < 3) continue;
        const gap = gapTo(lot);
        const r = rand();
        let top;
        if (gap < NEAR_RING) {
          // The neighbourhood: mid-rise, well below the office.
          top = STREET_Y + 10 + r * r * (-16 - (STREET_Y + 10));
        } else if (mayRise(lot, block)) {
          // The skyline behind the office: mostly around its height, with
          // landmark towers well above it further out.
          const landmark = gap > FAR_RING && rand() < 0.14;
          top = landmark ? 30 + rand() * 50 : -26 + r * 44;
        } else {
          // The camera's side of the city: always below the office floor.
          top = STREET_Y + 8 + r * r * (-LOW_ROOF_GAP - 4 - (STREET_Y + 8));
        }
        const building = {
          x: (fx0 + fx1) / 2,
          z: (fz0 + fz1) / 2,
          w: fx1 - fx0,
          d: fz1 - fz0,
          base: STREET_Y,
          top,
          tint: 1 + Math.floor(rand() * (TINTS.length - 1)),
          seed: rand(),
        };
        buildings.push(building);
        const units = Math.floor(rand() * 3);
        for (let i = 0; i < units; i++) {
          const w = 1 + rand() * 2.2;
          const d = 1 + rand() * 2.2;
          roofUnits.push({
            x: building.x + (rand() - 0.5) * Math.max(0, building.w - w - 1),
            z: building.z + (rand() - 0.5) * Math.max(0, building.d - d - 1),
            w,
            d,
            h: 0.8 + rand() * 1.8,
            base: top,
          });
        }
      }
    }

  return { buildings, blocks, roofUnits, trees, streetY: STREET_Y, room, block };
}
