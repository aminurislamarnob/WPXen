import { describe, expect, it } from 'vitest';
import {
  KEYFRAMES,
  PREVIEW_HOURS,
  SUNRISE,
  SUNSET,
  daylightAt,
  hourOf,
  keyLightDir,
  mixHex,
  sunPosition,
  wrapHour,
} from '../src/lib/office/scene/daylight.js';

// The Office is lit by the viewer's local clock. The lights and sky are
// reviewed through the dev Preview's time presets; these pin the model behind
// them: keyframes are hit exactly, blends stay between their neighbours, the
// sun arcs east → south → west and the key light never jumps.

const HEX = /^#[0-9a-f]{6}$/;
const len = (v) => Math.hypot(v[0], v[1], v[2]);

describe('office daylight', () => {
  it('returns each keyframe look exactly at its hour', () => {
    for (const k of KEYFRAMES) {
      const d = daylightAt(k.hour);
      expect(d.phase).toBe(k.phase);
      expect(d.skyTop).toBe(k.look.skyTop);
      expect(d.sunIntensity).toBeCloseTo(k.look.sunIntensity, 6);
      expect(d.windows).toBeCloseTo(k.look.windows, 6);
    }
  });

  it('keyframes run in order and midnight closes the loop', () => {
    const hours = KEYFRAMES.map((k) => k.hour);
    expect(hours[0]).toBe(0);
    expect([...hours].sort((a, b) => a - b)).toEqual(hours);
    expect(daylightAt(23.99).skyTop).toBe(daylightAt(0).skyTop);
    expect(daylightAt(24).skyTop).toBe(daylightAt(0).skyTop);
  });

  it('blends numbers and colours between neighbouring keyframes', () => {
    // 10:00 sits between morning (8) and noon (12.5).
    const d = daylightAt(10);
    expect(d.sunIntensity).toBeGreaterThan(1.95);
    expect(d.sunIntensity).toBeLessThan(2.1);
    for (const key of ['skyTop', 'skyHorizon', 'fog', 'sun', 'hemiSky', 'hemiGround'])
      expect(d[key]).toMatch(HEX);
  });

  it('keeps every value in range across the whole day', () => {
    for (let h = 0; h < 24; h += 0.25) {
      const d = daylightAt(h);
      for (const key of ['windows', 'stars', 'day']) {
        expect(d[key]).toBeGreaterThanOrEqual(0);
        expect(d[key]).toBeLessThanOrEqual(1);
      }
      expect(d.sunIntensity).toBeGreaterThan(0);
      expect(len(d.keyDir)).toBeCloseTo(1, 6);
      expect(d.keyDir[1]).toBeGreaterThan(0); // the key light always comes from above
    }
  });

  it('lights the city windows at night and not at noon', () => {
    expect(daylightAt(PREVIEW_HOURS.night).windows).toBe(1);
    expect(daylightAt(PREVIEW_HOURS.night).day).toBe(0);
    expect(daylightAt(PREVIEW_HOURS.day).windows).toBe(0);
    expect(daylightAt(PREVIEW_HOURS.day).day).toBe(1);
  });

  it('arcs the sun from east through south to west', () => {
    const morning = sunPosition(SUNRISE + 1).dir;
    const noon = sunPosition((SUNRISE + SUNSET) / 2).dir;
    const evening = sunPosition(SUNSET - 1).dir;
    expect(morning[0]).toBeGreaterThan(0.5); // east is +x
    expect(Math.abs(noon[0])).toBeLessThan(0.01);
    expect(noon[2]).toBeGreaterThan(0); // south is +z, the camera side
    expect(evening[0]).toBeLessThan(-0.5); // west is −x, the glazed left wall
    expect(sunPosition((SUNRISE + SUNSET) / 2).elevation).toBeGreaterThan(1);
    expect(sunPosition(2).elevation).toBeLessThan(0);
  });

  it('never lets the key light jump between minutes', () => {
    let prev = keyLightDir(0);
    for (let m = 1; m <= 24 * 60; m++) {
      const next = keyLightDir(m / 60);
      const dot = prev[0] * next[0] + prev[1] * next[1] + prev[2] * next[2];
      expect(dot).toBeGreaterThan(0.995);
      prev = next;
    }
  });

  it('wraps hours and reads the hour off a Date', () => {
    expect(wrapHour(25.5)).toBe(1.5);
    expect(wrapHour(-1)).toBe(23);
    expect(hourOf(new Date(2026, 0, 1, 18, 30))).toBe(18.5);
  });

  it('mixes hex colours in sRGB', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#102030', '#102030', 0.3)).toBe('#102030');
  });
});
