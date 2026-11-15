import { rng } from './city.js';

// ── Neon rooftop: layout ─────────────────────────────────────
// The pure half of the cyberpunk environment (scene/environments/
// Cyberpunk.jsx): where each project's neon sign hangs, where the flying cars
// dock, which lanes the traffic flies, where the rain falls, and how a
// lightning strike flashes. Kept DOM-free so the one rule that matters — no
// scenery above the office floor anywhere but behind the back wall or beyond
// the left wall, and never past the room's open sides — is tested, not hoped.

/** Wall height and thickness of the room shell (Room.jsx). */
const WALL_H = 3.1;
const WALL_T = 0.14;

/** Neon tubes, one per project, picked by a hash of its key. */
export const NEON = ['#ff3fb4', '#3ee8ff', '#b06bff', '#7dff6a', '#ffa23d', '#ff5a7a'];
/** The amber a sign pulses while one of its agents waits on you. */
export const NEON_WAITING = '#ffb020';

/** A project's neon colour: stable for its key, spread across the palette. */
export function neonFor(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return NEON[(h >>> 0) % NEON.length];
}

/**
 * The room's footprint including its walls: the back and left walls stand
 * outside plan.minZ / plan.minX, the open sides end at maxX + 1 / maxZ + 1.
 * @param {{ minX: number, maxX: number, minZ: number, maxZ: number }} bounds
 */
export function roomBox(bounds) {
  return {
    x0: bounds.minX - WALL_T,
    x1: bounds.maxX + 1,
    z0: bounds.minZ - WALL_T,
    z1: bounds.maxZ + 1,
    minX: bounds.minX,
    minZ: bounds.minZ,
  };
}

/**
 * Whether a point above the office floor stays out of the camera's way: behind
 * the back wall without reaching past the right side, or beyond the left wall
 * without reaching past the front.
 */
export function allowedAbove(x, z, room) {
  return (z < room.minZ && x <= room.x1) || (x < room.minX && z <= room.z1);
}

/** Sign size: a neon panel standing on the wall top. */
export const SIGN_W = 4.6;
export const SIGN_H = 1.15;
const SIGN_GAP = 0.9;

/**
 * Where project signs stand: along the top of the back wall first (facing the
 * room, +z), then along the left wall (facing +x). Each is just behind its
 * wall's inner face, so it is out of the room and out of the camera's way.
 * @returns {Array<{ x: number, y: number, z: number, yaw: number }>}
 */
export function signSlots(bounds) {
  const room = roomBox(bounds);
  const y = WALL_H + 0.3 + SIGN_H / 2;
  const row = (from, to) => {
    const n = Math.max(0, Math.floor((to - from - 1 + SIGN_GAP) / (SIGN_W + SIGN_GAP)));
    const used = n * SIGN_W + (n - 1) * SIGN_GAP;
    const start = (from + to) / 2 - used / 2 + SIGN_W / 2;
    return Array.from({ length: n }, (_, i) => start + i * (SIGN_W + SIGN_GAP));
  };
  return [
    ...row(room.x0, room.x1).map((x) => ({ x, y, z: room.minZ - 0.04, yaw: 0 })),
    ...row(room.z0, room.z1).map((z) => ({
      x: room.minX - 0.04,
      y,
      z,
      yaw: Math.PI / 2,
    })),
  ];
}

/** The sky-dock terrace reaches this far out from the back and left walls. */
export const DECK_DEPTH = 13.5;
/** Floor-level terrace slab thickness (it matches the room's floor slab). */
const DECK_T = 0.35;
const DOCK_PITCH = 4.4;

/**
 * The L-shaped landing terrace behind and left of the room, at floor level:
 * its slabs as boxes (centre + size).
 */
export function deckPieces(bounds) {
  const r = roomBox(bounds);
  const y = -DECK_T / 2;
  const box = (x0, x1, z0, z1) => ({
    x: (x0 + x1) / 2,
    y,
    z: (z0 + z1) / 2,
    w: x1 - x0,
    h: DECK_T,
    d: z1 - z0,
  });
  return [
    box(r.x0, r.x1, r.z0 - DECK_DEPTH, r.z0), // behind
    box(r.x0 - DECK_DEPTH, r.x0, r.z0, r.z1), // left
    box(r.x0 - DECK_DEPTH, r.x0, r.z0 - DECK_DEPTH, r.z0), // corner
  ];
}

/**
 * Hover docks on the terrace, most visible first: two rows behind the back
 * wall (cars nose along x), then two rows beyond the left wall (nose along z).
 * The rows sit far enough out that a car clears the wall and the signs on it
 * in the camera's view.
 * @returns {Array<{ x: number, z: number, yaw: number, out: [number, number] }>}
 *   `out` is the horizontal direction a car flies away along.
 */
export function dockSlots(bounds) {
  const r = roomBox(bounds);
  const along = (from, to) => {
    const n = Math.max(0, Math.floor((to - from - 1.4) / DOCK_PITCH));
    const start = (from + to) / 2 - ((n - 1) * DOCK_PITCH) / 2;
    return Array.from({ length: n }, (_, i) => start + i * DOCK_PITCH);
  };
  const docks = [];
  for (const depth of [6.6, 11.2])
    for (const x of along(r.x0, r.x1))
      docks.push({ x, z: r.z0 - depth, yaw: 0, out: [-0.32, -0.95] });
  for (const depth of [6.6, 11.2])
    for (const z of along(r.z0, r.z1))
      docks.push({ x: r.x0 - depth, z, yaw: Math.PI / 2, out: [-0.95, -0.32] });
  return docks;
}

/**
 * Flying-car traffic lanes. High lanes (above the office floor) only run
 * behind or left of the room and end at its right / front edge; low lanes
 * weave between the towers below the floor and may cross anywhere.
 * @returns {Array<{ x: number, y: number, z: number, yaw: number, len: number, speed: number, phase: number }>}
 *   Centre of the lane, its heading (yaw about y; a car flies along local +x),
 *   length, speed (units/s, sign = direction) and starting offset.
 */
export function trafficLanes(bounds, seed = 7) {
  const rand = rng(seed);
  const r = roomBox(bounds);
  const lanes = [];
  const cx = (r.x0 + r.x1) / 2;
  const cz = (r.z0 + r.z1) / 2;
  const cars = (lane, n) => {
    for (let i = 0; i < n; i++)
      lanes.push({
        ...lane,
        speed: (lane.speed ?? 1) * (9 + rand() * 8),
        phase: rand() * lane.len,
      });
  };
  // High, behind: along x, from far left up to the room's right edge.
  for (let i = 0; i < 4; i++) {
    const z = r.z0 - DECK_DEPTH - 6 - i * 9 - rand() * 4;
    const x0 = r.x0 - 160;
    cars(
      {
        x: (x0 + r.x1) / 2,
        y: 7 + rand() * 18,
        z,
        yaw: 0,
        len: r.x1 - x0,
        speed: rand() < 0.5 ? 1 : -1,
      },
      2 + Math.floor(rand() * 2)
    );
  }
  // High, left: along z, from far back up to the room's front edge.
  for (let i = 0; i < 3; i++) {
    const x = r.x0 - DECK_DEPTH - 6 - i * 9 - rand() * 4;
    const z0 = r.z0 - 160;
    cars(
      {
        x,
        y: 7 + rand() * 18,
        z: (z0 + r.z1) / 2,
        yaw: -Math.PI / 2,
        len: r.z1 - z0,
        speed: rand() < 0.5 ? 1 : -1,
      },
      2 + Math.floor(rand() * 2)
    );
  }
  // Low: criss-crossing the city below the floor.
  for (let i = 0; i < 10; i++) {
    const alongX = i % 2 === 0;
    const offset = (rand() - 0.3) * 120;
    cars(
      {
        x: alongX ? cx : cx + offset,
        y: -6 - rand() * 40,
        z: alongX ? cz + offset : cz,
        yaw: alongX ? 0 : -Math.PI / 2,
        len: 320,
        speed: rand() < 0.5 ? 1 : -1,
      },
      3 + Math.floor(rand() * 3)
    );
  }
  return lanes;
}

/**
 * Rain streaks: each falls through its own column from `top` to `top - span`.
 * Above the floor only behind or left of the room (never over the room or in
 * front of it), below the floor anywhere around the tower.
 * @returns {Array<{ x: number, z: number, top: number, span: number, phase: number, speed: number }>}
 */
export function rainDrops(bounds, count = 2400, seed = 11) {
  const rand = rng(seed);
  const r = roomBox(bounds);
  const drops = [];
  const above = Math.floor(count * 0.55);
  let guard = 0;
  while (drops.length < above && guard++ < count * 20) {
    const x = r.x0 - 45 + rand() * (r.x1 - r.x0 + 45);
    const z = r.z0 - 45 + rand() * (r.z1 - r.z0 + 45);
    if (!allowedAbove(x, z, r)) continue;
    drops.push({ x, z, top: 34, span: 34, phase: rand() * 34, speed: 26 + rand() * 10 });
  }
  while (drops.length < count) {
    const x = r.x0 - 60 + rand() * (r.x1 - r.x0 + 120);
    const z = r.z0 - 60 + rand() * (r.z1 - r.z0 + 120);
    drops.push({
      x,
      z,
      top: -0.6,
      span: 60,
      phase: rand() * 60,
      speed: 26 + rand() * 10,
    });
  }
  return drops;
}

/**
 * A lightning strike's brightness `age` seconds after it hit: a sharp first
 * flash, a brighter second stroke, a faint third, then nothing. 0..1.
 */
export function lightningFlash(age) {
  if (!(age >= 0) || age > 1.2) return 0;
  const pulse = (start, len, peak) =>
    age >= start && age < start + len ? peak * (1 - (age - start) / len) : 0;
  return Math.max(pulse(0, 0.09, 0.75), pulse(0.15, 0.14, 1), pulse(0.48, 0.12, 0.45));
}

/**
 * The "thunder-dark" after a strike: the city's own lights sag and stutter
 * for a moment. 0 (normal) .. 1 (darkest).
 */
export function lightningDark(age) {
  if (!(age >= 0.55) || age > 2.2) return 0;
  const fade = 1 - (age - 0.55) / 1.65;
  // A stutter rather than a smooth dip: on/off steps every ~70 ms.
  const step = Math.floor(age * 14) % 3 === 0 ? 0.35 : 1;
  return fade * step;
}
