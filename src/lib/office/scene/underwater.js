import { rng } from './city.js';

// ── Underwater dome: layout ──────────────────────────────────
// The pure half of the Underwater environment (scene/environments/
// Underwater.jsx): the glass dome the room stands under, where each agent's
// fish school hovers, and the seabed's rocks, coral, kelp and vents. Seeded
// and DOM-free, so the one rule every environment keeps — nothing above the
// office floor may stand between the camera and the room — is tested here
// (office-env-underwater.test.js).

/** The seabed, relative to the office floor at y = 0. */
export const SEABED_Y = -3;
/** Underside of the office floor slab: the room's pedestal runs from here to the sand. */
export const SLAB = 0.35;
/** Outer face of the room's back and left walls. */
const WALL_T = 0.14;
/** Fish stay this far outside the dome's glass. */
const SCHOOL_CLEARANCE = 3;
/** How far below the office floor anything on the camera's side keeps its top. */
export const TOP_GAP = 0.45;

/**
 * The room's footprint, walls included, and its centre.
 * @param {{ minX: number, maxX: number, minZ: number, maxZ: number }} bounds
 */
export function roomBox(bounds) {
  const x0 = bounds.minX - WALL_T;
  const x1 = bounds.maxX + 1;
  const z0 = bounds.minZ - WALL_T;
  const z1 = bounds.maxZ + 1;
  return { x0, x1, z0, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0 };
}

/**
 * The dome: an ellipsoid springing from the seabed, wide and tall enough that
 * the room — standing on its pedestal — is inside it up to the wall tops.
 * @param {ReturnType<typeof roomBox>} room
 */
export function domeShape(room) {
  const a = (room.w / 2) * 1.62 + 0.8;
  const c = (room.d / 2) * 1.62 + 0.8;
  const b = Math.max(14, 0.85 * Math.max(a, c));
  return { cx: room.cx, cz: room.cz, a, b, c, baseY: SEABED_Y };
}

/** Whether a point is inside the dome (its air), base included. */
export function insideDome(dome, x, y, z) {
  const dx = (x - dome.cx) / dome.a;
  const dy = (Math.max(y, dome.baseY) - dome.baseY) / dome.b;
  const dz = (z - dome.cz) / dome.c;
  return dx * dx + dy * dy + dz * dz < 1;
}

/**
 * Whether scenery at (x, z) may rise above the office floor: behind the back
 * wall without passing the room's right edge, or beyond the left wall without
 * passing its front edge (lib/office/scene/city.js mayRise, for points).
 */
export function mayRiseAt(room, x, z, margin = 0) {
  return (z < room.z0 - margin && x <= room.x1) || (x < room.x0 - margin && z <= room.z1);
}

/**
 * Where an agent's fish school hovers: just outside the dome on the side
 * nearer the agent's desk — behind the back wall or beyond the left wall,
 * both above the floor and both clear of the camera's line to the room.
 * Slots stagger schools that share a side.
 * @param {ReturnType<typeof domeShape>} dome
 * @param {ReturnType<typeof roomBox>} room
 * @param {{ x: number, z: number }} desk
 * @param {number} slot
 * @returns {{ x: number, y: number, z: number, side: 'back' | 'left', along: [number, number], out: [number, number] }}
 */
export function schoolAnchor(dome, room, desk, slot) {
  const fx = (desk.x - room.x0) / room.w;
  const fz = (desk.z - room.z0) / room.d;
  const y = 2.4 + (slot % 4) * 0.65;
  const shift = ((slot % 3) - 1) * 1.8;
  const ry = ((y - dome.baseY) / dome.b) ** 2;
  if (fx < fz) {
    const z = clamp(desk.z + shift, room.z0 + 1.2, room.z1 - 2);
    const r = 1 - ((z - dome.cz) / dome.c) ** 2 - ry;
    const glass = dome.cx - dome.a * Math.sqrt(Math.max(0, r));
    return {
      x: Math.min(glass, room.x0) - SCHOOL_CLEARANCE,
      y,
      z,
      side: 'left',
      along: [0, 1],
      out: [-1, 0],
    };
  }
  const x = clamp(desk.x + shift, room.x0 + 1.2, room.x1 - 2);
  const r = 1 - ((x - dome.cx) / dome.a) ** 2 - ry;
  const glass = dome.cz - dome.c * Math.sqrt(Math.max(0, r));
  return {
    x,
    y,
    z: Math.min(glass, room.z0) - SCHOOL_CLEARANCE,
    side: 'back',
    along: [1, 0],
    out: [0, -1],
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Coral and kelp colours; picked per piece. */
export const CORAL_COLORS = [
  '#f27c6c',
  '#f39a5d',
  '#e9b85e',
  '#c97fcf',
  '#ef7393',
  '#7cc9bf',
];
export const KELP_COLORS = ['#4f7a3a', '#5e8b3f', '#6b8f34', '#466f3e'];

/**
 * Rocks, coral, kelp and bubble vents on the seabed around the dome. Nothing
 * stands on the dome's base; anything on the camera's side keeps its top
 * below the office floor (with `TOP_GAP` to spare).
 * @param {ReturnType<typeof roomBox>} room
 * @param {ReturnType<typeof domeShape>} dome
 * @param {{ seed?: number, radius?: number }} [opts]
 */
export function planSeabed(room, dome, { seed = 5, radius = 95 } = {}) {
  const rand = rng(seed);
  const rocks = [];
  const corals = [];
  const kelp = [];
  const vents = [];
  /** Highest a top may reach at (x, z): free behind/left, under the floor elsewhere. */
  const ceiling = (x, z) => (mayRiseAt(room, x, z, 0.5) ? Infinity : -TOP_GAP);
  /** A random spot on the seabed off the dome's base, or null. */
  const spot = (min = 0) => {
    const ang = rand() * Math.PI * 2;
    const dist = min + rand() ** 0.8 * (radius - min);
    const x = dome.cx + Math.cos(ang) * (dome.a + 1.4 + dist);
    const z = dome.cz + Math.sin(ang) * (dome.c + 1.4 + dist);
    return { x, z };
  };
  const fit = (p, height) => Math.min(height, ceiling(p.x, p.z) - SEABED_Y);

  for (let i = 0; i < 70; i++) {
    const p = spot();
    const s = 0.6 + rand() ** 2 * 3.4;
    const h = fit(p, s * (0.5 + rand() * 0.5));
    if (h < 0.2) continue;
    rocks.push({ ...p, s, h, yaw: rand() * Math.PI });
  }
  for (let i = 0; i < 60; i++) {
    const p = spot(rand() < 0.6 ? 0 : 8);
    const color = CORAL_COLORS[Math.floor(rand() * CORAL_COLORS.length)];
    const branches = 3 + Math.floor(rand() * 5);
    for (let b = 0; b < branches; b++) {
      const x = p.x + (rand() - 0.5) * 1.6;
      const z = p.z + (rand() - 0.5) * 1.6;
      const h = fit({ x, z }, 0.5 + rand() * 1.3);
      if (h < 0.2) continue;
      corals.push({
        kind: rand() < 0.65 ? 'branch' : 'blob',
        x,
        z,
        h,
        s: 0.15 + rand() * 0.35,
        tilt: (rand() - 0.5) * 0.7,
        yaw: rand() * Math.PI * 2,
        color,
      });
    }
  }
  for (let i = 0; i < 46; i++) {
    const p = spot(rand() < 0.5 ? 0 : 6);
    const tall = mayRiseAt(room, p.x, p.z, 0.5);
    const blades = 3 + Math.floor(rand() * 5);
    for (let b = 0; b < blades; b++) {
      const x = p.x + (rand() - 0.5) * 1.4;
      const z = p.z + (rand() - 0.5) * 1.4;
      // Swaying adds at most ~0.1 of the height sideways, never upwards.
      const h = fit({ x, z }, tall ? 4 + rand() * 7 : 1 + rand() * 1.5);
      if (h < 0.5) continue;
      kelp.push({
        x,
        z,
        h,
        w: 0.22 + rand() * 0.16,
        yaw: rand() * Math.PI,
        color: KELP_COLORS[Math.floor(rand() * KELP_COLORS.length)],
      });
    }
  }
  for (let i = 0; i < 8; i++) {
    const p = spot(rand() * 10);
    vents.push({ ...p, top: Math.min(9, ceiling(p.x, p.z)) });
  }
  return { rocks, corals, kelp, vents };
}
