// ── Office floor plan ────────────────────────────────────────
// Project pods sit on a fixed grid; desks inside a pod are rows of three.
// Slots are sticky: a pod or desk keeps its position for as long as it lives,
// and freed slots are reused lowest-first. Pure math, no React, no DOM —
// ported whole from the source scene (web/src/scene/layout.ts), including the
// amenity strip the lounge furniture fills and the break routes commuters
// walk.

export const DESK_PITCH = 1.85;
export const ROW_PITCH = 2.6;
export const DESKS_PER_ROW = 3;
export const POD_COLS = 3;
const POD_W = DESKS_PER_ROW * DESK_PITCH + 1.6;
const POD_ROWS_MIN = 1;
export const LOUNGE_DEPTH = 3.4; // amenity strip along the back wall
export const SIDE_DEPTH = 2.4; // amenity strip along the left wall
/** Narrowest room that still fits the lounge, coffee bar and play zone. */
const MIN_ROOM_X = 9.1;

const ZONES = [
  { kind: 'lounge', w: 3.2 },
  { kind: 'coffee', w: 2.6 },
  { kind: 'play', w: 4.2 },
  { kind: 'screen', w: 2.3 },
  { kind: 'neon', w: 1.6 },
  { kind: 'arcade', w: 1.4 },
];
export const PINGPONG_HALF = 1.45; // table centre to player
/** Standing table in the coffee zone, relative to the zone origin on the back wall. */
export const COFFEE_TABLE = { x: 0.55, z: 1.8 };
/** Lounge furniture, relative to the zone origin on the back wall. */
export const LOUNGE = {
  sofa: { x: 0, z: 0.62, seat: 0.55, seats: [-0.6, 0, 0.6] },
  table: { x: 0.1, z: 1.75 },
  beanBags: [
    { x: -1.0, z: 2.25, facing: 0.5 },
    { x: 1.15, z: 2.15, facing: 0.9 },
  ],
  /** Top of the bean bag's hollow; matches BeanBag's geometry. */
  beanBagSeat: 0.27,
};

function planAmenities(maxX) {
  const bz = -LOUNGE_DEPTH;
  const right = maxX + 1;
  const zones = [];
  let x = -SIDE_DEPTH + 1.3;
  for (const z of ZONES) {
    if (x + z.w > right - 0.6 + 1e-6) break;
    zones.push({ kind: z.kind, x: x + z.w / 2 });
    x += z.w + 0.25;
  }
  const at = (kind) => zones.find((z) => z.kind === kind).x;
  const lounge = at('lounge');
  const coffee = at('coffee');
  const play = at('play');
  const table = { x: play, z: bz + 1.7 };
  // Three around the standing table, two by the counter; most face the camera.
  const tx = coffee + COFFEE_TABLE.x;
  const tz = bz + COFFEE_TABLE.z;
  const round = [-2.5, -1.6, 2.7].map((a, i) => ({
    id: `coffee-table-${i}`,
    activity: 'coffee',
    x: tx + Math.sin(a) * 0.62,
    z: tz + Math.cos(a) * 0.62,
    facing: a + Math.PI,
  }));
  const counter = [
    { dx: -0.8, dz: 1.05, facing: 0.5 },
    { dx: -1.0, dz: 1.75, facing: 0.9 },
  ].map((c, i) => ({
    id: `coffee-bar-${i}`,
    activity: 'coffee',
    x: coffee + c.dx,
    z: bz + c.dz,
    facing: c.facing,
  }));
  return {
    zones,
    table,
    corridorZ: -0.45,
    spots: [
      {
        id: 'pingpong-0',
        activity: 'pingpong',
        x: table.x - PINGPONG_HALF,
        z: table.z,
        facing: Math.PI / 2,
      },
      {
        id: 'pingpong-1',
        activity: 'pingpong',
        x: table.x + PINGPONG_HALF,
        z: table.z,
        facing: -Math.PI / 2,
      },
      round[0],
      counter[0],
      round[1],
      counter[1],
      round[2],
      // Sofa sitters slip in through the gap between the sofa and the coffee table.
      ...LOUNGE.sofa.seats.map((dx, i) => {
        const gap = bz + (LOUNGE.sofa.z + LOUNGE.table.z) / 2 + 0.03;
        return {
          id: `lounge-sofa-${i}`,
          activity: 'lounge',
          x: lounge + LOUNGE.sofa.x + dx,
          z: bz + LOUNGE.sofa.z,
          facing: 0,
          seat: LOUNGE.sofa.seat,
          via: [
            { x: lounge - 1.35, z: gap },
            { x: lounge + LOUNGE.sofa.x + dx, z: gap },
          ],
        };
      }),
      ...LOUNGE.beanBags.map((p, i) => ({
        id: `lounge-beanbag-${i}`,
        activity: 'lounge',
        x: lounge + p.x,
        z: bz + p.z,
        facing: p.facing,
        seat: LOUNGE.beanBagSeat,
      })),
    ],
  };
}

/** Sticky key → slot map; freed slots are reused lowest-first. */
export class SlotAllocator {
  constructor() {
    this.slots = new Map();
  }

  sync(keys) {
    const live = new Set(keys);
    for (const k of [...this.slots.keys()]) if (!live.has(k)) this.slots.delete(k);
    const used = new Set(this.slots.values());
    for (const k of keys) {
      if (this.slots.has(k)) continue;
      let i = 0;
      while (used.has(i)) i++;
      used.add(i);
      this.slots.set(k, i);
    }
    return this.slots;
  }
}

export function createAllocators() {
  return { pods: new SlotAllocator(), desks: new Map() };
}

export function planFloor(office, alloc) {
  const byProject = new Map();
  for (const s of Object.values(office.sessions)) {
    const list = byProject.get(s.projectKey) ?? [];
    list.push(s);
    byProject.set(s.projectKey, list);
  }
  // Initial order is alphabetical so a fresh load is predictable.
  const projectKeys = [...byProject.keys()].sort();
  const podSlots = alloc.pods.sync(projectKeys);
  for (const k of [...alloc.desks.keys()]) if (!byProject.has(k)) alloc.desks.delete(k);

  // Desk slots per pod.
  const podDesks = new Map();
  for (const key of projectKeys) {
    const sessions = byProject.get(key).sort((a, b) => a.startedAt - b.startedAt);
    let da = alloc.desks.get(key);
    if (!da) alloc.desks.set(key, (da = new SlotAllocator()));
    const ids = sessions.map((s) => String(s.pid));
    podDesks.set(key, {
      slots: new Map(da.sync(ids)),
      sessions: new Map(sessions.map((s) => [String(s.pid), s])),
    });
  }

  // Row depth of each grid row grows only if a pod needs more than two desk rows.
  const gridRows = new Map();
  for (const key of projectKeys) {
    const slot = podSlots.get(key);
    const maxSlot = Math.max(...podDesks.get(key).slots.values());
    const rows = Math.max(POD_ROWS_MIN, Math.floor(maxSlot / DESKS_PER_ROW) + 1);
    const gr = Math.floor(slot / POD_COLS);
    gridRows.set(gr, Math.max(gridRows.get(gr) ?? POD_ROWS_MIN, rows));
  }
  const maxGridRow = Math.max(0, ...gridRows.keys());
  const rowZ = [];
  let z = 0;
  for (let r = 0; r <= maxGridRow; r++) {
    rowZ.push(z);
    z += (gridRows.get(r) ?? POD_ROWS_MIN) * ROW_PITCH + 0.6;
  }
  const usedCols = Math.min(
    POD_COLS,
    Math.max(1, ...[...podSlots.values()].map((s) => s + 1))
  );

  const pods = projectKeys.map((key) => {
    const slot = podSlots.get(key);
    const gr = Math.floor(slot / POD_COLS);
    const px = (slot % POD_COLS) * POD_W;
    const pz = rowZ[gr];
    const { slots, sessions } = podDesks.get(key);
    const rows = gridRows.get(gr) ?? POD_ROWS_MIN;
    const occupied = new Map([...slots].map(([id, i]) => [i, id]));
    const filled = Math.max(...slots.values()) + 1;
    // One spare hot desk per pod keeps the office lived-in without looking deserted.
    const total = filled % DESKS_PER_ROW === 0 ? filled : filled + 1;
    const desks = [];
    for (let i = 0; i < total; i++) {
      const id = occupied.get(i);
      desks.push({
        key: id ?? `${key}#empty${i}`,
        session: id ? sessions.get(id) : null,
        x: px + 1.0 + DESK_PITCH / 2 + (i % DESKS_PER_ROW) * DESK_PITCH,
        z: pz + 0.9 + Math.floor(i / DESKS_PER_ROW) * ROW_PITCH,
      });
    }
    // Slots left over in the last desk row become a small break-out nook.
    const nooks = [];
    for (let i = total; i % DESKS_PER_ROW !== 0; i++)
      nooks.push({
        x: px + 1.0 + DESK_PITCH / 2 + (i % DESKS_PER_ROW) * DESK_PITCH,
        z: pz + 0.9 + Math.floor(i / DESKS_PER_ROW) * ROW_PITCH,
      });
    return {
      projectKey: key,
      x: px,
      z: pz,
      width: POD_W,
      depth: rows * ROW_PITCH,
      desks,
      nooks,
    };
  });

  const maxX = Math.max(usedCols * POD_W, MIN_ROOM_X);
  return {
    pods,
    amenities: planAmenities(maxX),
    minX: -SIDE_DEPTH,
    maxX,
    minZ: -LOUNGE_DEPTH,
    maxZ: Math.max(z, 5.5),
  };
}

// ── Break routes ─────────────────────────────────────────────
// Characters walk out behind their chair row, down the aisle left of their pod,
// and along the corridor in front of the amenity strip.

export function routeToBreak(plan, desk, spot) {
  const row = desk.z - 0.62;
  const aisle = desk.podX - 0.45;
  const corridor = plan.amenities.corridorZ;
  const via = spot.via ?? [];
  const entry = via[0] ?? spot;
  return [
    { x: desk.x, z: desk.z - 0.08 },
    { x: desk.x, z: row },
    { x: aisle, z: row },
    { x: aisle, z: corridor },
    { x: entry.x, z: corridor },
    ...via,
    { x: spot.x, z: spot.z },
  ];
}

// ── Intern seating ───────────────────────────────────────────
// Subagents pull up stools in a row in front of their parent's desk: the
// source renders at most three (Workstation.tsx slice(0, 3)), each 0.55 apart
// from x = -0.5 at z = 1.42, angled -0.25 toward the parent; anything beyond
// the third stool is a "+n" overflow badge instead of more furniture.

export const INTERN_SEATS = 3;

/**
 * Seat plan for a session's subagents: at most INTERN_SEATS stools plus an
 * overflow count. Pure value — Workstation renders it verbatim.
 */
export function internBench(subagents) {
  const all = Object.values(subagents ?? {});
  return {
    seated: all.slice(0, INTERN_SEATS).map((sub, i) => ({
      sub,
      x: -0.5 + i * 0.55,
      z: 1.42,
      yaw: -0.25,
    })),
    overflow: Math.max(0, all.length - INTERN_SEATS),
  };
}
