import { mayRise, rng } from './city.js';

// ── Tropical island ──────────────────────────────────────────
// The layout behind scene/environments/Island.jsx: the room as an open-air
// pavilion on a wooden deck over a lagoon, the beach behind it, a pier running
// out to sea with a mooring per agent, and the palms, hills and gulls around.
// Pure and seeded, so the same room always stands on the same beach, and the
// one rule every environment keeps — nothing above the office floor except
// behind the back wall or beyond the left wall — is checked in
// office-env-island.test.js rather than trusted to the eye.
//
// The sea level, the beach and the shoreline are an analytic height field
// (terrainHeight). Island.jsx evaluates the same formula in GLSL to tint the
// water by depth and draw the surf line — keep the two in step.

/** Water level, below the office floor (y = 0). */
export const SEA_Y = -2.3;
/** Top of the wooden deck the room stands on (just under the floor slab). */
export const DECK_TOP = -0.37;
/** Underside of the deck's frame. */
export const DECK_BOTTOM = -0.62;
/** Deck beyond the room on its open (front and right) sides. */
export const DECK_MARGIN = 2.4;
/** Deck beyond the walls on the back and left. */
export const DECK_BACK_MARGIN = 0.7;
/** Top of the pier: a step down from the deck, so its lanterns stay below the floor. */
export const PIER_TOP = -1.2;
/** Pier width. */
export const PIER_W = 2;
/** Boats the pier can moor; agents beyond it get none. */
export const MOORINGS = 12;
/** Spacing between moorings along one side of the pier. */
export const MOOR_SPACING = 3.7;
/** Tallest point of a moored boat above the water (mast and lantern). */
export const BOAT_TOP = 2.05;
/** Seconds a boat takes to sail in, and to sail away. */
export const SAIL_IN_S = 7;
export const SAIL_OUT_S = 4;
/** Wall thickness (Room.jsx WALL_T). */
const WALL_T = 0.14;

/** Offshore direction: toward the camera's side, where the lagoon opens to the sea. */
const UX = 0.62;
const UZ = 0.78;
/** Shoreline, measured along the offshore direction from the room's centre. */
export const SHORE = -4;

/**
 * Ground (or seabed) height at a point: the beach rises behind the room to a
 * crest just under the floor, the lagoon deepens gently in front of it. The
 * shoreline wanders a little along its length.
 * @param {number} x
 * @param {number} z
 * @param {{ cx: number, cz: number }} c The room's centre.
 */
export function terrainHeight(x, z, c) {
  const dx = x - c.cx;
  const dz = z - c.cz;
  const s = dx * UX + dz * UZ;
  const t = -dx * UZ + dz * UX;
  const shore = SHORE + 2.4 * Math.sin(t * 0.07) + 1.1 * Math.sin(t * 0.19 + 1.3);
  const d = s - shore;
  return d > 0 ? SEA_Y - Math.min(d * 0.11, 5) : SEA_Y + Math.min(-d * 0.13, 2);
}

/** Seaward distance of a point past the shoreline (negative: on the beach). */
export function shoreDistance(x, z, c) {
  const dx = x - c.cx;
  const dz = z - c.cz;
  const s = dx * UX + dz * UZ;
  const t = -dx * UZ + dz * UX;
  return s - (SHORE + 2.4 * Math.sin(t * 0.07) + 1.1 * Math.sin(t * 0.19 + 1.3));
}

/** GLSL twin of terrainHeight / shoreDistance (uCenter = the room's centre). */
export const TERRAIN_GLSL = /* glsl */ `
float islandShore( vec2 p ) {
  vec2 d = p - uCenter;
  float s = d.x * ${UX.toFixed(2)} + d.y * ${UZ.toFixed(2)};
  float t = -d.x * ${UZ.toFixed(2)} + d.y * ${UX.toFixed(2)};
  return s - ( ${SHORE.toFixed(1)} + 2.4 * sin( t * 0.07 ) + 1.1 * sin( t * 0.19 + 1.3 ) );
}
float islandGround( vec2 p ) {
  float d = islandShore( p );
  return d > 0.0 ? ${SEA_Y.toFixed(2)} - min( d * 0.11, 5.0 ) : ${SEA_Y.toFixed(2)} + min( -d * 0.13, 2.0 );
}
`;

/**
 * Everything fixed by the room's bounds: the room, the deck around it, the
 * pier and its moorings.
 * @param {{ minX: number, maxX: number, minZ: number, maxZ: number }} bounds
 */
export function islandLayout(bounds) {
  const room = {
    x0: bounds.minX - WALL_T,
    x1: bounds.maxX + 1,
    z0: bounds.minZ - WALL_T,
    z1: bounds.maxZ + 1,
  };
  const c = { cx: (room.x0 + room.x1) / 2, cz: (room.z0 + room.z1) / 2 };
  const deck = {
    x0: room.x0 - DECK_BACK_MARGIN,
    x1: room.x1 + DECK_MARGIN,
    z0: room.z0 - DECK_BACK_MARGIN,
    z1: room.z1 + DECK_MARGIN,
  };
  // Boats tie up first along the deck's front edge — the band of water the
  // default framing shows below the room — and the rest along a pier that
  // leaves the deck's right edge near the back.
  const front = [];
  for (
    let x = room.x0 + 2.2;
    x <= deck.x1 - 1.6 && front.length < MOORINGS;
    x += MOOR_SPACING
  )
    front.push({ x, z: deck.z1 + 1.55, side: 1 });
  const pierZ = room.z0 + Math.min(4.5, (room.z1 - room.z0) * 0.32);
  const rest = MOORINGS - front.length;
  const rows = Math.ceil(rest / 2);
  const pier = {
    x0: deck.x1,
    x1: deck.x1 + 3 + Math.max(rows, 2) * MOOR_SPACING + 1.5,
    z: pierZ,
  };
  /** @type {Array<{ x: number, z: number, side: number }>} */
  const moorings = [
    ...front,
    ...Array.from({ length: rest }, (_, i) => {
      const side = i % 2 ? 1 : -1;
      return {
        x: pier.x0 + 4 + Math.floor(i / 2) * MOOR_SPACING,
        z: pierZ + side * (PIER_W / 2 + 1.05),
        side,
      };
    }),
  ];
  return { room, c, deck, pier, moorings, frontBerths: front.length };
}

/**
 * Where a dolphin leaps for an agent that finished its turn: just seaward of
 * the deck's front row of boats, between berths — the band of water the
 * default framing always shows — beside the agent's own boat when it is on
 * that row. `lane` spreads simultaneous leaps apart along the row.
 * @param {ReturnType<typeof islandLayout>} layout
 * @param {number | undefined} slot The agent's berth, if it has one.
 * @param {number} lane
 */
export function leapSpot(layout, slot, lane = 0) {
  const row = Math.max(1, layout.frontBerths);
  const at = slot !== undefined && slot < row ? slot : Math.min(1, row - 1);
  const m = layout.moorings[at];
  return { x: m.x + MOOR_SPACING / 2 + lane * 2.4, z: m.z + 2.2 };
}

/**
 * A point on a boat's way in from the open sea (u = 0) to its mooring
 * (u = 1): a quadratic Bézier sweeping in from the open water in front,
 * ending alongside its berth bow toward +x. Every point of the way is on
 * the seaward side of the berth, so a boat never crosses the room. Returns
 * the position and the heading (yaw about +y, 0 = bow toward +x).
 * @param {{ x: number, z: number, side: number }} m
 * @param {number} u 0..1
 */
export function sailIn(m, u) {
  const p0x = m.x + 34;
  const p0z = m.z + 56 * m.side;
  const p1x = m.x - 12;
  const p1z = m.z + 7 * m.side;
  const t = Math.min(1, Math.max(0, u));
  const a = (1 - t) * (1 - t);
  const b = 2 * (1 - t) * t;
  const cc = t * t;
  const x = a * p0x + b * p1x + cc * m.x;
  const z = a * p0z + b * p1z + cc * m.z;
  // Heading follows the direction of travel (toward the mooring, i.e. -x),
  // then the boat swings round to lie bow-out at its berth.
  const dx = 2 * (1 - t) * (p1x - p0x) + 2 * t * (m.x - p1x);
  const dz = 2 * (1 - t) * (p1z - p0z) + 2 * t * (m.z - p1z);
  const travel = Math.atan2(-dz, dx);
  const swing = Math.min(1, Math.max(0, (t - 0.82) / 0.18));
  return { x, z, yaw: travel + (0 - travel) * swing * swing };
}

/**
 * A point on a boat's way out (u = 0 at the mooring, 1 out at sea): it pulls
 * away bow-first along the pier and heads for the horizon.
 * @param {{ x: number, z: number, side: number }} m
 * @param {number} u 0..1
 */
export function sailOut(m, u) {
  const t = Math.min(1, Math.max(0, u));
  const p1x = m.x + 16;
  const p1z = m.z + 2 * m.side;
  const p2x = m.x + 46;
  const p2z = m.z + 60 * m.side;
  const a = (1 - t) * (1 - t);
  const b = 2 * (1 - t) * t;
  const cc = t * t;
  const dx = 2 * (1 - t) * (p1x - m.x) + 2 * t * (p2x - p1x);
  const dz = 2 * (1 - t) * (p1z - m.z) + 2 * t * (p2z - p1z);
  return {
    x: a * m.x + b * p1x + cc * p2x,
    z: a * m.z + b * p1z + cc * p2z,
    yaw: Math.atan2(-dz, dx),
  };
}

/**
 * Whether a footprint may rise above the office floor (the city's rule,
 * against the room's own rectangle).
 */
export function mayRiseHere(x0, x1, z0, z1, room) {
  return mayRise({ x0, x1, z0, z1 }, room);
}

/**
 * Palms, bushes and the distant hills, seeded per room kind. Palms and hills
 * only stand where they may rise above the floor (behind or left of the
 * room); bushes elsewhere are kept low enough to stay under it.
 * @param {ReturnType<typeof islandLayout>} layout
 * @param {number} seed
 */
export function islandScenery(layout, seed = 5) {
  const rand = rng(seed);
  const { room, c, deck } = layout;
  const palms = [];
  const bushes = [];
  const hills = [];

  const onLand = (x, z) => shoreDistance(x, z, c) < -1.6;

  // Palms: a grove along the beach behind and left of the deck.
  for (let tries = 0; palms.length < 30 && tries < 900; tries++) {
    const behind = rand() < 0.55;
    const x = behind
      ? room.x0 - 8 + rand() * (room.x1 - room.x0 + 6)
      : room.x0 - 3 - rand() * 26;
    const z = behind
      ? room.z0 - 3 - rand() * 24
      : room.z0 - 8 + rand() * (room.z1 - room.z0 + 6);
    const height = 5.2 + rand() * 2.6;
    const lean = 0.08 + rand() * 0.22;
    // Crown reach: the fronds, plus how far the lean carries the crown sideways.
    const r = 1.9 + lean * height;
    if (!mayRiseHere(x - r, x + r, z - r, z + r, room)) continue;
    if (!onLand(x, z)) continue;
    if (palms.some((p) => Math.hypot(p.x - x, p.z - z) < 3.2)) continue;
    palms.push({
      x,
      z,
      y: terrainHeight(x, z, c),
      height,
      lean,
      reach: r,
      yaw: rand() * Math.PI * 2,
      phase: rand() * Math.PI * 2,
    });
  }

  // Bushes: under the palms, and a few low ones on the open beach.
  for (let tries = 0; bushes.length < 46 && tries < 1200; tries++) {
    const x = room.x0 - 30 + rand() * (room.x1 - room.x0 + 34);
    const z = room.z0 - 30 + rand() * (room.z1 - room.z0 + 34);
    if (!onLand(x, z)) continue;
    if (x > deck.x0 - 1 && x < deck.x1 + 1 && z > deck.z0 - 1 && z < deck.z1 + 1)
      continue;
    // Small near the pavilion, fuller further back.
    const near = Math.max(room.x0 - x, room.z0 - z, 0);
    const size = (0.45 + rand() * 0.6) * (near < 8 ? 0.8 : 1.35);
    const y = terrainHeight(x, z, c);
    const rises = mayRiseHere(x - size, x + size, z - size, z + size, room);
    if (!rises && y + size * 0.9 > -0.1) continue;
    bushes.push({ x, z, y, size, tone: rand() });
  }

  // Hills: a green ridge far behind and to the left, fading into the haze.
  for (let i = 0; i < 14; i++) {
    const behind = i % 2 === 0;
    const x = behind ? c.cx - 70 + rand() * 120 : room.x0 - 55 - rand() * 70;
    const z = behind ? room.z0 - 50 - rand() * 70 : c.cz - 60 + rand() * 70;
    const w = 18 + rand() * 26;
    const h = 8 + rand() * 18;
    if (!mayRiseHere(x - w, x + w, z - w, z + w, room)) continue;
    hills.push({ x, z, w, d: w * (0.7 + rand() * 0.5), h, tone: rand() });
  }
  return { palms, bushes, hills };
}

/**
 * Raindrop spans for a storm: [x, z, top, bottom] each, only where they keep
 * clear of the room — any height behind or left of it, below the floor
 * everywhere else.
 * @param {ReturnType<typeof islandLayout>} layout
 * @param {number} count
 * @param {number} seed
 */
export function rainDrops(layout, count, seed = 9) {
  const rand = rng(seed);
  const { room, c } = layout;
  const drops = [];
  while (drops.length < count) {
    const x = c.cx - 70 + rand() * 140;
    const z = c.cz - 70 + rand() * 140;
    const rises = mayRiseHere(x - 0.5, x + 0.5, z - 0.5, z + 0.5, room);
    const over = x > room.x0 - 1 && x < room.x1 + 1 && z > room.z0 - 1 && z < room.z1 + 1;
    if (over) continue;
    drops.push([x, z, rises ? 22 : -0.3, SEA_Y]);
  }
  return drops;
}
