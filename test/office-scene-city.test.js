import { describe, expect, it } from 'vitest';
import {
  LOW_ROOF_GAP,
  SLAB_DEPTH,
  STREET_Y,
  TINTS,
  mayRise,
  planCity,
  rng,
} from '../src/lib/office/scene/city.js';

// The city the Office tower stands in. Its look is reviewed in the dev
// Preview; these pin the layout rules, above all the one that keeps the room
// visible: only lots behind or left of the tower may rise above its floor.

const BOUNDS = { minX: -2, maxX: 17, minZ: -1, maxZ: 12 };
const overlaps = (a, b) =>
  a.x - a.w / 2 < b.x + b.w / 2 &&
  b.x - b.w / 2 < a.x + a.w / 2 &&
  a.z - a.d / 2 < b.z + b.d / 2 &&
  b.z - b.d / 2 < a.z + a.d / 2;

describe('office city', () => {
  it('is the same city for the same seed and a different one for another', () => {
    expect(planCity(BOUNDS, { seed: 4 })).toEqual(planCity(BOUNDS, { seed: 4 }));
    expect(planCity(BOUNDS, { seed: 4 }).buildings).not.toEqual(
      planCity(BOUNDS, { seed: 5 }).buildings
    );
  });

  it('puts the office tower first, under the floor slab, down to the street', () => {
    const { buildings, room } = planCity(BOUNDS);
    const tower = buildings[0];
    expect(tower.tint).toBe(0);
    expect(tower.top).toBe(-SLAB_DEPTH);
    expect(tower.base).toBe(STREET_Y);
    expect(tower.x - tower.w / 2).toBeGreaterThanOrEqual(room.x0);
    expect(tower.x + tower.w / 2).toBeLessThanOrEqual(room.x1);
  });

  it('keeps every roof on the camera side below the office floor', () => {
    for (const seed of [1, 2, 3, 99]) {
      const { buildings, block } = planCity(BOUNDS, { seed });
      for (const b of buildings.slice(1)) {
        const lot = {
          x0: b.x - b.w / 2,
          x1: b.x + b.w / 2,
          z0: b.z - b.d / 2,
          z1: b.z + b.d / 2,
        };
        if (!mayRise(lot, block)) expect(b.top).toBeLessThanOrEqual(-LOW_ROOF_GAP);
      }
    }
  });

  it('keeps rooftop plant on low roofs below the floor too', () => {
    const { roofUnits, block } = planCity(BOUNDS, { seed: 7 });
    for (const u of roofUnits) {
      const lot = {
        x0: u.x - u.w / 2,
        x1: u.x + u.w / 2,
        z0: u.z - u.d / 2,
        z1: u.z + u.d / 2,
      };
      if (!mayRise(lot, block)) expect(u.base + u.h).toBeLessThan(0);
    }
  });

  it('builds a skyline behind the office', () => {
    const { buildings } = planCity(BOUNDS);
    expect(buildings.some((b) => b.top > 10)).toBe(true);
  });

  it('only lets lots fully behind or left of the tower rise', () => {
    const tower = { x0: 0, x1: 10, z0: 0, z1: 10 };
    expect(mayRise({ x0: -20, x1: -5, z0: 2, z1: 8 }, tower)).toBe(true); // left
    expect(mayRise({ x0: 2, x1: 8, z0: -20, z1: -5 }, tower)).toBe(true); // behind
    expect(mayRise({ x0: -20, x1: -5, z0: -20, z1: -5 }, tower)).toBe(true); // back-left
    expect(mayRise({ x0: 12, x1: 20, z0: 2, z1: 8 }, tower)).toBe(false); // right
    expect(mayRise({ x0: 2, x1: 8, z0: 12, z1: 20 }, tower)).toBe(false); // front
    expect(mayRise({ x0: -20, x1: -5, z0: 12, z1: 20 }, tower)).toBe(false); // front-left
    expect(mayRise({ x0: 12, x1: 20, z0: -20, z1: -5 }, tower)).toBe(false); // back-right
  });

  it('never stands a building on the tower block or on another building', () => {
    const { buildings, block } = planCity(BOUNDS, { seed: 3 });
    const tower = {
      x: (block.x0 + block.x1) / 2,
      z: (block.z0 + block.z1) / 2,
      w: block.x1 - block.x0,
      d: block.z1 - block.z0,
    };
    const rest = buildings.slice(1);
    for (const b of rest) expect(overlaps(b, tower)).toBe(false);
    for (let i = 0; i < rest.length; i++)
      for (let j = i + 1; j < rest.length; j++)
        expect(overlaps(rest[i], rest[j])).toBe(false);
  });

  it('gives every building a valid tint, a positive height and a footprint', () => {
    const { buildings } = planCity(BOUNDS);
    for (const b of buildings) {
      expect(b.tint).toBeGreaterThanOrEqual(0);
      expect(b.tint).toBeLessThan(TINTS.length);
      expect(b.top).toBeGreaterThan(b.base);
      expect(b.w).toBeGreaterThan(0);
      expect(b.d).toBeGreaterThan(0);
    }
  });

  it('draws numbers in [0, 1) from the PRNG', () => {
    const r = rng(42);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
