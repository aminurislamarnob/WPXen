import { rng } from './city.js';

// ── Green view: the garden plan ──────────────────────────────
// The Office as a glass pavilion in a garden: the room on a low stone plinth
// above a striped lawn, flower beds along its front, a pond and a stepping-
// stone path to its right, a fence behind it where the agents' birds perch,
// specimen trees and a forest edge behind and to its left, rolling hills in
// the haze beyond. Pure and seeded — scene/environments/Green.jsx draws it.
//
// ⚠️ Nothing may come between the camera and the room. The camera orbits only
// within azimuth 0.12–1.45 rad, looking down, so every sight line from the
// room to the camera heads toward +x and +z and climbs. Something entirely
// behind the room's back edge (z ≤ room.z0) or entirely left of its left edge
// (x ≤ room.x0) can therefore never cross one, and neither can anything whose
// top is below the floor (y ≤ 0). `clearsView` is that rule; every item this
// plan places keeps it, and office-env-green.test.js checks it — including by
// casting the sight lines themselves.

/** Lawn level, relative to the office floor at y = 0. */
export const LAWN_Y = -1.2;
/** Underside of the office's floor slab, where the plinth begins. */
const SLAB_DEPTH = 0.35;
/** How far the plinth's stone ledge reaches past the slab. */
const LEDGE = 0.45;
/** Back fence: how far behind the back wall, and its rail height above the lawn. */
const FENCE_GAP = 7;
const RAIL_H = 1.05;
/** Spacing of the birds' perches along the fences. */
const PERCH_STEP = 1.7;
/** Flowers that may bloom while the page is open. */
export const BLOOM_CAP = 30;

/**
 * Whether an axis-aligned box can never hide any part of the room from the
 * camera: it lies wholly behind the room, wholly left of it, or wholly below
 * the office floor.
 * @param {{ x0: number, x1: number, z0: number, z1: number, top: number }} box
 * @param {{ x0: number, z0: number }} room
 */
export function clearsView(box, room) {
  return box.z1 <= room.z0 || box.x1 <= room.x0 || box.top <= 0;
}

/**
 * A point on a bird's flight: a quadratic arc from `a` to `b` that rises
 * `lift` above the higher end at its middle. u in 0..1.
 * @param {{ x: number, y: number, z: number }} a
 * @param {{ x: number, y: number, z: number }} b
 * @param {number} u
 * @param {number} [lift]
 * @param {{ x: number, y: number, z: number }} [out]
 */
export function flightPoint(a, b, u, lift = 2.5, out = { x: 0, y: 0, z: 0 }) {
  const t = Math.min(1, Math.max(0, u));
  const cx = (a.x + b.x) / 2;
  const cy = Math.max(a.y, b.y) + lift;
  const cz = (a.z + b.z) / 2;
  const s = 1 - t;
  out.x = s * s * a.x + 2 * s * t * cx + t * t * b.x;
  out.y = s * s * a.y + 2 * s * t * cy + t * t * b.y;
  out.z = s * s * a.z + 2 * s * t * cz + t * t * b.z;
  return out;
}

/**
 * The garden around a room.
 * @param {{ minX: number, maxX: number, minZ: number, maxZ: number }} bounds
 *   The floor plan's bounds (the room's far edges are maxX + 1 / maxZ + 1).
 * @param {{ seed?: number, wall?: number }} [opts]
 */
export function planGarden(bounds, { seed = 5, wall = 0.14 } = {}) {
  const rand = rng(seed);
  const room = {
    x0: bounds.minX - wall,
    x1: bounds.maxX + 1,
    z0: bounds.minZ - wall,
    z1: bounds.maxZ + 1,
  };
  const w = room.x1 - room.x0;
  const d = room.z1 - room.z0;
  const cx = (room.x0 + room.x1) / 2;
  const cz = (room.z0 + room.z1) / 2;
  const between = (a, b) => a + rand() * (b - a);

  /** Built pieces — stone, soil, timber — one box each: { x, y, z, w, h, d, kind }. */
  const built = [];
  const box = (x0, x1, y0, y1, z0, z1, kind) =>
    built.push({
      x: (x0 + x1) / 2,
      y: (y0 + y1) / 2,
      z: (z0 + z1) / 2,
      w: x1 - x0,
      h: y1 - y0,
      d: z1 - z0,
      kind,
    });

  // The plinth under the slab, its ledge showing round the cut-away edges,
  // and three steps down to the lawn at the front.
  const plinth = {
    x0: room.x0 - LEDGE,
    x1: room.x1 + LEDGE,
    z0: room.z0 - LEDGE,
    z1: room.z1 + LEDGE,
  };
  box(plinth.x0, plinth.x1, LAWN_Y, -SLAB_DEPTH, plinth.z0, plinth.z1, 'stone');
  const rise = (-SLAB_DEPTH - LAWN_Y) / 3;
  for (let i = 0; i < 3; i++)
    box(
      cx - 1.7,
      cx + 1.7,
      LAWN_Y,
      LAWN_Y + rise * (3 - i),
      plinth.z1,
      plinth.z1 + 0.42 * (i + 1),
      'stone'
    );
  const stepsEnd = plinth.z1 + 1.26;

  // Flower beds along the front, split by the steps, and one down the right.
  const bedZ0 = stepsEnd + 0.5;
  const bedZ1 = bedZ0 + 1.6;
  const beds = [
    { x0: plinth.x0 + 0.6, x1: cx - 2.4, z0: bedZ0, z1: bedZ1 },
    { x0: cx + 2.4, x1: plinth.x1 - 0.6, z0: bedZ0, z1: bedZ1 },
    { x0: plinth.x1 + 1.1, x1: plinth.x1 + 2.8, z0: plinth.z0 + 1, z1: plinth.z1 - 1 },
  ].filter((b) => b.x1 - b.x0 > 1.5 && b.z1 - b.z0 > 1);
  for (const b of beds) box(b.x0, b.x1, LAWN_Y, LAWN_Y + 0.22, b.z0, b.z1, 'soil');

  // Flowers: a few already out, and the spots that bloom as agents finish.
  const flowerSpots = [];
  for (const b of beds) {
    const area = (b.x1 - b.x0) * (b.z1 - b.z0);
    const n = Math.round(area * 3.4);
    for (let i = 0; i < n; i++)
      flowerSpots.push({
        x: between(b.x0 + 0.25, b.x1 - 0.25),
        z: between(b.z0 + 0.25, b.z1 - 0.25),
        y: LAWN_Y + 0.22,
      });
  }
  // Interleave: every other spot is a bloom spot, so blooms spread over every bed.
  const flowers = flowerSpots.filter((_, i) => i % 2 === 1).slice(0, 60);
  const bloomSpots = flowerSpots.filter((_, i) => i % 2 === 0).slice(0, BLOOM_CAP);

  // A pond and the stepping-stone path that winds from the steps to it.
  const pond = { x: room.x1 + 8.5, z: cz + d * 0.15, r: Math.min(5.5, 2.5 + d * 0.18) };
  const lilyPads = Array.from({ length: 7 }, () => {
    const a = rand() * Math.PI * 2;
    const r = rand() * pond.r * 0.7;
    return {
      x: pond.x + Math.cos(a) * r,
      z: pond.z + Math.sin(a) * r,
      s: between(0.35, 0.6),
    };
  });
  const pondRim = Array.from({ length: 22 }, (_, i) => {
    const a = (i / 22) * Math.PI * 2 + rand() * 0.1;
    return {
      x: pond.x + Math.cos(a) * (pond.r + 0.25),
      z: pond.z + Math.sin(a) * (pond.r + 0.25),
      s: between(0.3, 0.55),
    };
  });
  const path = [];
  const from = { x: cx, z: stepsEnd + 0.4 };
  const to = { x: pond.x - pond.r - 0.9, z: pond.z + pond.r * 0.4 };
  const bend = { x: (from.x + to.x) / 2 + 2, z: Math.max(from.z, to.z) + 3.5 };
  for (let u = 0; u <= 1.0001; u += 1 / 11) {
    const s = 1 - u;
    path.push({
      x: s * s * from.x + 2 * s * u * bend.x + u * u * to.x + between(-0.15, 0.15),
      z: s * s * from.z + 2 * s * u * bend.z + u * u * to.z + between(-0.15, 0.15),
      s: between(0.42, 0.55),
      yaw: rand() * Math.PI,
    });
  }
  // Low garden lamps along the path: posts are built pieces, heads glow at night.
  const lamps = path
    .filter((_, i) => i % 3 === 1)
    .map((p, i) => ({ x: p.x + (i % 2 ? 0.9 : -0.9), z: p.z + 0.4 }));
  for (const l of lamps)
    box(l.x - 0.07, l.x + 0.07, LAWN_Y, -0.45, l.z - 0.07, l.z + 0.07, 'post');

  // The fences the birds perch on: one behind the back wall, one beyond the left.
  const perches = [];
  const backZ = room.z0 - FENCE_GAP;
  const leftX = room.x0 - FENCE_GAP;
  const railY = LAWN_Y + RAIL_H;
  const fenceX0 = leftX;
  const fenceX1 = room.x1 + 6;
  const fenceZ1 = room.z1 - 0.5;
  for (let x = fenceX0; x <= fenceX1 + 0.01; x += 2.2)
    box(x - 0.07, x + 0.07, LAWN_Y, railY + 0.08, backZ - 0.07, backZ + 0.07, 'timber');
  for (let z = backZ + 2.2; z <= fenceZ1 + 0.01; z += 2.2)
    box(leftX - 0.07, leftX + 0.07, LAWN_Y, railY + 0.08, z - 0.07, z + 0.07, 'timber');
  for (const y of [railY - 0.45, railY]) {
    box(fenceX0, fenceX1, y - 0.06, y, backZ - 0.05, backZ + 0.05, 'timber');
    box(leftX - 0.05, leftX + 0.05, y - 0.06, y, backZ, fenceZ1, 'timber');
  }
  // Birds face the camera side (+x, +z) a little either way.
  for (let x = room.x0 + 0.6; x <= room.x1 + 4.5; x += PERCH_STEP)
    perches.push({
      x,
      y: railY,
      z: backZ,
      yaw: 0.6 + between(-0.35, 0.35),
      side: 'back',
    });
  for (let z = backZ + 3; z <= fenceZ1 - 0.4; z += PERCH_STEP)
    perches.push({
      x: leftX,
      y: railY,
      z,
      yaw: 0.85 + between(-0.35, 0.35),
      side: 'left',
    });

  // A bird bath on the left lawn.
  const bath = { x: leftX + 3, z: room.z0 + d * 0.55 };
  box(
    bath.x - 0.12,
    bath.x + 0.12,
    LAWN_Y,
    LAWN_Y + 0.8,
    bath.z - 0.12,
    bath.z + 0.12,
    'stone'
  );
  box(
    bath.x - 0.5,
    bath.x + 0.5,
    LAWN_Y + 0.8,
    LAWN_Y + 0.92,
    bath.z - 0.5,
    bath.z + 0.5,
    'stone'
  );

  // Trees: specimens near the garden, then a forest edge, behind and left only.
  const trees = [];
  const tree = (x, z, scale, kind) =>
    trees.push({
      x,
      z,
      kind,
      trunk: (kind === 'cone' ? 1.2 : 2.2) * scale,
      r: (kind === 'cone' ? 1.5 : 2.2) * scale * between(0.85, 1.15),
      h: (kind === 'cone' ? 5.5 : 3.2) * scale * between(0.9, 1.15),
    });
  for (let x = room.x0 - 4; x < room.x1 + 10; x += between(4.5, 7))
    tree(x, backZ - between(3.5, 7), between(0.9, 1.3), rand() < 0.35 ? 'cone' : 'round');
  for (let z = backZ + 4; z < room.z1 + 4; z += between(4.5, 7))
    tree(leftX - between(3.5, 7), z, between(0.9, 1.3), rand() < 0.35 ? 'cone' : 'round');
  for (let i = 0; i < 150; i++) {
    const behind = rand() < 0.6;
    const x = behind
      ? between(room.x0 - 70, room.x1 + 70)
      : between(room.x0 - 60, room.x0 - 20);
    const z = behind
      ? between(room.z0 - 55, room.z0 - 22)
      : between(room.z0 - 20, room.z1 + 40);
    tree(x, z, between(0.8, 1.5), rand() < 0.45 ? 'cone' : 'round');
  }

  // Shrubs: hugging the plinth (kept low) and softening the fences.
  const bushes = [];
  for (let x = plinth.x0 + 0.5; x < plinth.x1; x += between(1.6, 2.6))
    if (Math.abs(x - cx) > 2.2)
      bushes.push({ x, z: plinth.z1 + 0.35, r: between(0.35, 0.55), y: LAWN_Y });
  for (let z = plinth.z0 + 0.8; z < plinth.z1; z += between(1.8, 2.8))
    bushes.push({ x: plinth.x1 + 0.35, z, r: between(0.35, 0.55), y: LAWN_Y });
  for (let x = fenceX0 + 1; x < fenceX1; x += between(2.5, 4))
    bushes.push({ x, z: backZ - 0.9, r: between(0.6, 1.1), y: LAWN_Y });
  for (let z = backZ + 1; z < fenceZ1; z += between(2.5, 4))
    bushes.push({ x: leftX - 0.9, z, r: between(0.6, 1.1), y: LAWN_Y });

  // Rolling hills just past the forest edge, behind and to the left, softening
  // into the haze. Each is placed by its radius so none reaches the room.
  const hills = [];
  for (let i = 0; i < 9; i++) {
    const r = between(30, 55);
    hills.push({
      x: cx + between(-140, 140),
      z: room.z0 - r - between(28, 70),
      r,
      h: between(0.24, 0.4),
    });
  }
  for (let i = 0; i < 6; i++) {
    const r = between(30, 50);
    hills.push({
      x: room.x0 - r - between(30, 70),
      z: cz + between(-50, 90),
      r,
      h: between(0.24, 0.38),
    });
  }

  // Fireflies: drifting over the lawn behind and left, and low in the front beds.
  const fireflies = [];
  for (let i = 0; i < 70; i++) {
    const zone = rand();
    if (zone < 0.45)
      fireflies.push({
        x: between(room.x0 - 6, room.x1 + 8),
        y: between(LAWN_Y + 0.4, 2.2),
        z: between(backZ - 6, room.z0 - 1),
      });
    else if (zone < 0.75)
      fireflies.push({
        x: between(leftX - 6, room.x0 - 1),
        y: between(LAWN_Y + 0.4, 2.2),
        z: between(backZ, room.z1 + 4),
      });
    else
      fireflies.push({
        x: between(room.x0, pond.x + pond.r),
        // Low over the front beds: even at the top of its drift it stays under the floor.
        y: between(LAWN_Y + 0.25, -0.75),
        z: between(room.z1 + 1, room.z1 + 9),
      });
  }

  // The mown lawn around the pavilion (the meadow beyond is plain ground).
  // The mown lawn stops at the fences; beyond them is rougher meadow.
  const lawn = {
    x0: leftX,
    x1: pond.x + pond.r + 9,
    z0: backZ,
    z1: room.z1 + 14,
  };

  return {
    room,
    plinth,
    lawn,
    built,
    beds,
    flowers,
    bloomSpots,
    pond,
    lilyPads,
    pondRim,
    path,
    lamps,
    perches,
    bath,
    trees,
    bushes,
    hills,
    fireflies,
    center: { x: cx, z: cz },
    size: { w, d },
  };
}

// How the renderer sizes each kind of item; itemBoxes() below uses the same
// numbers, so the view-clearance test checks exactly what is drawn.
/** A shrub: centre lifted `lift`·r above its ground, height `squash`·r. */
export const BUSH = { lift: 0.7, squash: 0.85 };
/** A hill: sunk a quarter of its height into the ground. */
export const HILL_SINK = 0.25;
/** How far a firefly drifts from its home point. */
export const FIREFLY_DRIFT = 0.6;
/** A perched bird's reach, and how high it hops or a rain cloud hangs above it. */
export const BIRD_REACH = 0.7;
export const CLOUD_HEIGHT = 2.4;

/**
 * Every item the garden places, as the axis-aligned box it is drawn in —
 * what the view-clearance test checks.
 * @param {ReturnType<typeof planGarden>} g
 */
export function itemBoxes(g) {
  const boxes = [];
  const add = (name, x, z, rx, rz, top) =>
    boxes.push({ name, x0: x - rx, x1: x + rx, z0: z - rz, z1: z + rz, top });
  for (const b of g.built)
    add(`built:${b.kind}`, b.x, b.z, b.w / 2, b.d / 2, b.y + b.h / 2);
  for (const t of g.trees)
    add(`tree:${t.kind}`, t.x, t.z, t.r, t.r, LAWN_Y + t.trunk + t.h);
  for (const b of g.bushes)
    add('bush', b.x, b.z, b.r, b.r, b.y + b.r * (BUSH.lift + BUSH.squash));
  for (const h of g.hills)
    add('hill', h.x, h.z, h.r, h.r, LAWN_Y + h.r * h.h * (1 - HILL_SINK));
  for (const f of g.fireflies)
    add('firefly', f.x, f.z, FIREFLY_DRIFT, FIREFLY_DRIFT, f.y + FIREFLY_DRIFT);
  for (const p of g.perches)
    add(`perch:${p.side}`, p.x, p.z, BIRD_REACH, BIRD_REACH, p.y + CLOUD_HEIGHT + 0.6);
  for (const f of [...g.flowers, ...g.bloomSpots])
    add('flower', f.x, f.z, 0.2, 0.2, f.y + 0.5);
  add('pond', g.pond.x, g.pond.z, g.pond.r + 0.8, g.pond.r + 0.8, LAWN_Y + 0.3);
  return boxes;
}

/**
 * Where a bird comes from and goes to: high and far off on its own side of
 * the room (behind for the back fence, left for the left one), so the whole
 * flight stays where it can't cross the room.
 * @param {{ x: number, y: number, z: number, side: string }} perch
 * @param {'in' | 'out'} way
 */
export function flightEnd(perch, way) {
  const far = way === 'in' ? 1 : 1.15;
  return perch.side === 'back'
    ? { x: perch.x - 14 * far, y: perch.y + 9, z: perch.z - 22 * far }
    : { x: perch.x - 22 * far, y: perch.y + 9, z: perch.z - 12 * far };
}
