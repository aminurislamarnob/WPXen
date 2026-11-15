import { describe, expect, it } from 'vitest';
import {
  ARRIVE_S,
  AZIMUTH_RANGE,
  DEPART_S,
  HULL_BOTTOM,
  POLAR_RANGE,
  PORT_Y,
  PORT_Y_LOW,
  SLAB_BOTTOM,
  arrivalPose,
  beacon,
  departurePose,
  dockedAt,
  dockingPorts,
  earthNearestAtTarget,
  earthPlacement,
  earthSun,
  shootingStarPath,
  stationFrame,
  viewFrom,
} from '../src/lib/office/scene/space.js';

// The Space station environment's layout and choreography. The look is
// reviewed in the dev sandbox; these pin the rules it depends on: shuttles
// stay below the office floor on the camera's side, flights end where they
// should, and the Earth can never come between the camera and the station.

const BOUNDS = { minX: -2, maxX: 17, minZ: -1, maxZ: 12 };
const target = () => {
  const f = stationFrame(BOUNDS);
  return [f.cx, 0.4, f.cz];
};
const len = (v) => Math.hypot(v[0], v[1], v[2]);

describe('office space station', () => {
  it('builds the hull from the slab down', () => {
    expect(HULL_BOTTOM).toBeLessThan(SLAB_BOTTOM);
    expect(PORT_Y).toBeLessThan(SLAB_BOTTOM);
    expect(PORT_Y).toBeGreaterThan(HULL_BOTTOM);
    expect(PORT_Y_LOW).toBeLessThan(PORT_Y);
    expect(PORT_Y_LOW).toBeGreaterThan(HULL_BOTTOM);
  });

  it('puts ports on the front and right faces, below the floor', () => {
    const f = stationFrame(BOUNDS);
    const ports = dockingPorts(BOUNDS);
    // Two rows: a dozen-plus agents each get a berth in a typical room.
    expect(ports.length).toBeGreaterThanOrEqual(12);
    // The upper row is handed out first.
    const firstLow = ports.findIndex((p) => p.y !== ports[0].y);
    expect(ports.slice(firstLow).every((p) => p.y < ports[0].y)).toBe(true);
    for (const p of ports) {
      expect(p.y).toBeLessThan(0);
      if (p.face === 'front') {
        expect(p.z).toBe(f.z1);
        expect(p.x).toBeGreaterThan(f.x0);
        expect(p.x).toBeLessThan(f.x1);
      } else {
        expect(p.x).toBe(f.x1);
        expect(p.z).toBeGreaterThan(f.z0);
        expect(p.z).toBeLessThan(f.z1);
      }
    }
  });

  it('points a docked shuttle nose-in, outside the hull', () => {
    const f = stationFrame(BOUNDS);
    for (const p of dockingPorts(BOUNDS)) {
      const [x, , z] = dockedAt(p);
      // Nose (local +z) after yaw: (sin yaw, cos yaw) must point back at the hull.
      expect(Math.sin(p.yaw) * p.out[0] + Math.cos(p.yaw) * p.out[2]).toBeCloseTo(-1, 6);
      if (p.face === 'front') expect(z).toBeGreaterThan(f.z1);
      else expect(x).toBeGreaterThan(f.x1);
    }
  });

  it('flies in from far away and ends exactly at the port, never above the floor', () => {
    for (const p of dockingPorts(BOUNDS)) {
      const start = arrivalPose(p, 0);
      const [dx, dy, dz] = dockedAt(p);
      expect(Math.hypot(start.x - dx, start.z - dz)).toBeGreaterThan(20);
      expect(start.thrust).toBe(1);
      const end = arrivalPose(p, ARRIVE_S + 1);
      expect(end.x).toBeCloseTo(dx, 6);
      expect(end.y).toBeCloseTo(dy, 6);
      expect(end.z).toBeCloseTo(dz, 6);
      expect(end.thrust).toBe(0);
      for (let t = 0; t <= ARRIVE_S; t += 0.1)
        expect(arrivalPose(p, t).y).toBeLessThan(0);
    }
  });

  it('backs out, turns round and leaves, then is gone', () => {
    const [p] = dockingPorts(BOUNDS);
    const first = departurePose(p, 0);
    expect(first.yaw).toBeCloseTo(p.yaw, 6);
    const away = departurePose(p, DEPART_S - 0.01);
    expect(away.yaw).toBeCloseTo(p.yaw + Math.PI, 6);
    expect(away.thrust).toBe(1);
    expect(Math.hypot(away.x - p.x, away.z - p.z)).toBeGreaterThan(20);
    for (let t = 0; t < DEPART_S; t += 0.1) expect(departurePose(p, t).y).toBeLessThan(0);
    expect(departurePose(p, DEPART_S)).toBeNull();
  });

  it('never lets the Earth cover the station from any camera angle', () => {
    const t = target();
    const earth = earthPlacement(t);
    for (let polar = POLAR_RANGE[0]; polar <= POLAR_RANGE[1]; polar += 0.05)
      for (let az = AZIMUTH_RANGE[0]; az <= AZIMUTH_RANGE[1]; az += 0.05) {
        const near = earthNearestAtTarget(t, earth, viewFrom(polar, az));
        // Either the disc misses the room centre, or it is far behind it.
        if (near !== null) expect(near).toBeLessThan(-40);
      }
  });

  it('shows the Earth below the room in the default view', () => {
    const t = target();
    const earth = earthPlacement(t);
    expect(earth.center[1]).toBeLessThan(-200);
    expect(len(earth.center.map((c, i) => c - t[i]))).toBeGreaterThan(earth.radius);
  });

  it('lights the station side of the Earth at noon and darkens it at midnight', () => {
    const t = target();
    const earth = earthPlacement(t);
    const below = t.map((c, i) => c - earth.center[i]);
    const toward = (v) =>
      (v[0] * below[0] + v[1] * below[1] + v[2] * below[2]) / len(below);
    expect(toward(earthSun(earth, t, 12))).toBeCloseTo(1, 6);
    expect(toward(earthSun(earth, t, 0))).toBeLessThan(-0.5);
    expect(Math.abs(toward(earthSun(earth, t, 6)))).toBeLessThan(0.5);
  });

  it('shows a beacon for each agent state', () => {
    expect(beacon('error', 0.3)).toMatchObject({ color: '#ff3b30', on: true });
    expect(beacon('waiting_on_user', 0.2).on).toBe(true);
    expect(beacon('waiting_on_user', 0.8).on).toBe(false);
    expect(beacon('working', 0.1).on).toBe(true);
    expect(beacon('working', 1).on).toBe(false);
  });

  it('streaks shooting stars far behind the station, on the camera side never', () => {
    const t = target();
    const f = stationFrame(BOUNDS);
    for (let seed = 0; seed < 20; seed++) {
      const { from, to } = shootingStarPath(t, seed);
      for (const p of [from, to]) {
        expect(p[0]).toBeLessThan(f.x0);
        expect(p[2]).toBeLessThan(f.z0);
      }
    }
  });
});
