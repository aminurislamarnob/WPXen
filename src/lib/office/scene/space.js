// ── Space station ────────────────────────────────────────────
// Pure layout and choreography behind the Space station environment
// (scene/environments/Space.jsx): where the station's hull and docking ports
// sit around the room, how a shuttle flies in, docks and leaves, where the
// Earth hangs so it can never come between the camera and the station, and
// what a shuttle's beacon shows. Everything here is plain numbers, so the
// rules the scene depends on are testable without WebGL.

/** Wall thickness the room's shell adds outside plan.minX / plan.minZ. */
const WALL_T = 0.14;
/** The floor slab's underside: the hull starts here. */
export const SLAB_BOTTOM = -0.35;
/** The hull's underside. */
export const HULL_BOTTOM = -6.4;
/** Height of the docking ports' axis: below the office floor, high enough on the hull to stay in frame. */
export const PORT_Y = -1.95;
/** A second, staggered row lower on the hull, used once the first is full. */
export const PORT_Y_LOW = -4.75;
/** Docking tube length, out from the hull face. */
export const PORT_LEN = 0.8;
/** Shuttle length, nose to tail. */
export const SHUTTLE_LEN = 2.7;
/** Gap between neighbouring docking ports along a hull face. */
const PORT_PITCH = 3.0;
/** Seconds a shuttle takes to fly in and dock. */
export const ARRIVE_S = 3.2;
/** Seconds a shuttle takes to undock, turn and leave (inside the engine's 4 s linger). */
export const DEPART_S = 3.4;

/**
 * The camera's default view direction (target → camera), the same vector
 * OfficeScene frames with, and the OrbitControls limits it can be dragged to.
 */
export const VIEW_DIR = normalize([1, 0.92, 1.12]);
export const POLAR_RANGE = [0.55, 1.2];
export const AZIMUTH_RANGE = [0.12, 1.45];

/** @param {number[]} v */
export function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const ease = (t) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/** The camera direction for an OrbitControls polar/azimuth pair. */
export function viewFrom(polar, azimuth) {
  return [
    Math.sin(polar) * Math.sin(azimuth),
    Math.cos(polar),
    Math.sin(polar) * Math.cos(azimuth),
  ];
}

/**
 * The station module the room is: its footprint (the room's, walls included)
 * and centre.
 * @param {{ minX: number, maxX: number, minZ: number, maxZ: number }} bounds
 */
export function stationFrame(bounds) {
  const x0 = bounds.minX - WALL_T;
  const x1 = bounds.maxX + 1;
  const z0 = bounds.minZ - WALL_T;
  const z1 = bounds.maxZ + 1;
  return { x0, x1, z0, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0 };
}

/**
 * Docking ports along the hull's two faces the camera sees, in the order
 * agents are given them: the upper row first (front +z left to right, then
 * right +x front to back), then the lower row, staggered half a berth. Each
 * port has the face point it leaves from, the outward direction, and the yaw
 * that points a shuttle's nose (its local +z) back into the port.
 * @param {{ minX: number, maxX: number, minZ: number, maxZ: number }} bounds
 */
export function dockingPorts(bounds) {
  const f = stationFrame(bounds);
  const ports = [];
  const along = (from, to, shift) => {
    const n = Math.max(1, Math.floor((to - from) / PORT_PITCH));
    const step = (to - from) / n;
    return Array.from(
      { length: n - (shift ? 1 : 0) },
      (_, i) => from + step * (i + 0.5 + shift)
    );
  };
  for (const [y, shift] of [
    [PORT_Y, 0],
    [PORT_Y_LOW, 0.5],
  ]) {
    for (const x of along(f.x0 + 1.2, f.x1 - 1.2, shift))
      ports.push({ x, y, z: f.z1, out: [0, 0, 1], yaw: Math.PI, face: 'front' });
    for (const z of along(f.z0 + 1.2, f.z1 - 1.2, shift))
      ports.push({ x: f.x1, y, z, out: [1, 0, 0], yaw: -Math.PI / 2, face: 'right' });
  }
  return ports;
}

/** Where a shuttle sits while docked at a port: its centre. */
export function dockedAt(port) {
  const reach = PORT_LEN + SHUTTLE_LEN / 2;
  return [port.x + port.out[0] * reach, port.y, port.z + port.out[2] * reach];
}

/**
 * A shuttle's pose: centre, yaw (nose = local +z) and engine thrust 0..1,
 * or null when it isn't in the scene.
 * @typedef {{ x: number, y: number, z: number, yaw: number, thrust: number } | null} Pose
 */

/** Writes a pose into `out` (or a new object) and returns it. */
function pose(out, x, y, z, yaw, thrust) {
  const o = out ?? {};
  o.x = x;
  o.y = y;
  o.z = z;
  o.yaw = yaw;
  o.thrust = thrust;
  return o;
}

/**
 * Flying in: a curve from far out and below, slowing onto the port nose first.
 * Pass `out` to reuse an object (the frame loop does); scalar maths only.
 * @param {ReturnType<typeof dockingPorts>[number]} port
 * @param {number} t Seconds since the agent arrived.
 * @param {object} [out]
 * @returns {Pose}
 */
export function arrivalPose(port, t, out) {
  const reach = PORT_LEN + SHUTTLE_LEN / 2;
  const ox = port.out[0];
  const oz = port.out[2];
  const dx = port.x + ox * reach;
  const dy = port.y;
  const dz = port.z + oz * reach;
  // Lateral offset: sideways along the face, so ships don't all fly the same line.
  const lx = -oz;
  const lz = ox;
  const u = 1 - (1 - Math.min(1, Math.max(0, t / ARRIVE_S))) ** 3; // ease out
  const a = (1 - u) * (1 - u);
  const b = 2 * (1 - u) * u;
  const c = u * u;
  return pose(
    out,
    a * (dx + ox * 34 + lx * 9) + b * (dx + ox * 9) + c * dx,
    a * (dy - 9) + b * (dy - 1.2) + c * dy,
    a * (dz + oz * 34 + lz * 9) + b * (dz + oz * 9) + c * dz,
    port.yaw,
    1 - u
  );
}

/**
 * Leaving: back off the port, turn round, then burn away and down.
 * Pass `out` to reuse an object (the frame loop does).
 * @param {ReturnType<typeof dockingPorts>[number]} port
 * @param {number} t Seconds since the agent left.
 * @param {object} [out]
 * @returns {Pose}
 */
export function departurePose(port, t, out) {
  if (t >= DEPART_S) return null;
  const reach = PORT_LEN + SHUTTLE_LEN / 2;
  const ox = port.out[0];
  const oz = port.out[2];
  const dx = port.x + ox * reach;
  const dy = port.y;
  const dz = port.z + oz * reach;
  if (t < 0.9) {
    const k = 1.6 * ease(t / 0.9);
    return pose(out, dx + ox * k, dy, dz + oz * k, port.yaw, 0.15);
  }
  const bx = dx + ox * 1.6;
  const bz = dz + oz * 1.6;
  if (t < 1.8) {
    const turn = Math.PI * ease((t - 0.9) / 0.9);
    return pose(out, bx, dy, bz, port.yaw + turn, 0.15);
  }
  const s = (t - 1.8) / (DEPART_S - 1.8);
  const run = 34 * s * s;
  return pose(out, bx + ox * run, dy - 7 * s * s, bz + oz * run, port.yaw + Math.PI, 1);
}

/**
 * Where the Earth hangs: a sphere far below and behind the station, placed so
 * its horizon crosses the view a few units above the room's centre. Its
 * centre is `depth` behind the target along the view and `drop` below it on
 * screen, with `drop` just under the radius — so the target sits just outside
 * the planet's disc and any part of the disc that covers the station is
 * hundreds of units behind it, whichever way the camera is orbited.
 * @param {number[]} target The room's centre.
 */
export function earthPlacement(target, { radius = 280, depth = 340, limb = 6 } = {}) {
  const v = VIEW_DIR;
  const up = normalize([-v[1] * v[0], 1 - v[1] * v[1], -v[1] * v[2]]); // screen up
  const drop = radius - limb;
  const center = [0, 1, 2].map((i) => target[i] - v[i] * depth - up[i] * drop);
  return { center, radius };
}

/**
 * The nearest point of the Earth along a view direction, as a signed
 * distance in front of the target (positive = closer to the camera), or null
 * when the planet's disc doesn't cover the target from that direction.
 */
export function earthNearestAtTarget(target, earth, view) {
  const rel = [0, 1, 2].map((i) => earth.center[i] - target[i]);
  const along = dot(rel, view);
  const perp2 = dot(rel, rel) - along * along;
  if (perp2 >= earth.radius * earth.radius) return null;
  return along + Math.sqrt(earth.radius * earth.radius - perp2);
}

/**
 * The axis the sun circles the Earth on, and the direction it shines from at a
 * local hour: overhead the station at noon, behind the planet at midnight, the
 * terminator sweeping across the view at dawn and dusk.
 * @param {ReturnType<typeof earthPlacement>} earth
 * @param {number[]} target
 * @param {number} hour
 */
export function earthSun(earth, target, hour) {
  const below = normalize([0, 1, 2].map((i) => target[i] - earth.center[i]));
  const right = normalize(cross([0, 1, 0], VIEW_DIR));
  // Tilt the axis so the terminator crosses the view at an angle, not flat.
  const axis = normalize([0, 1, 2].map((i) => right[i] + 0.45 * below[i]));
  const a = ((hour - 12) / 24) * Math.PI * 2;
  // Rodrigues: rotate `below` about `axis` by `a`.
  const c = Math.cos(a);
  const s = Math.sin(a);
  const k = cross(axis, below);
  const kd = dot(axis, below);
  return normalize(
    [0, 1, 2].map((i) => below[i] * c + k[i] * s + axis[i] * kd * (1 - c))
  );
}

/**
 * A shuttle's beacon: red while its agent errors, blinking amber while it
 * waits on you, a slow white nav strobe otherwise. Pass `out` to reuse an object.
 * @param {string} state
 * @param {number} time Seconds (any running clock).
 * @param {object} [out]
 * @returns {{ color: string, on: boolean, glow: number }}
 */
export function beacon(state, time, out) {
  const o = out ?? {};
  if (state === 'error') {
    o.color = '#ff3b30';
    o.on = true;
    o.glow = 1;
  } else if (state === 'waiting_on_user') {
    o.color = '#ffb020';
    o.on = time % 1 < 0.55;
    o.glow = 1;
  } else {
    o.color = '#e8f1ff';
    o.on = time % 2.4 < 0.18;
    o.glow = 0.6;
  }
  return o;
}

/**
 * A shooting star's start and end, far behind the station and high on the
 * screen, varied by `seed` so two in a row don't overlap.
 * @param {number[]} target
 * @param {number} seed
 */
export function shootingStarPath(target, seed) {
  const v = VIEW_DIR;
  const up = normalize([-v[1] * v[0], 1 - v[1] * v[1], -v[1] * v[2]]);
  const right = normalize(cross([0, 1, 0], v));
  const r = (n) => (((Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453) % 1) + 1) % 1;
  const back = 70 + r(1) * 30;
  const height = 9 + r(2) * 5;
  const from = -22 + r(3) * 14;
  const at = (side, lift) =>
    [0, 1, 2].map(
      (i) => target[i] - v[i] * back + up[i] * (height + lift) + right[i] * side
    );
  return { from: at(from, 2.5), to: at(from + 24, -2.5) };
}
