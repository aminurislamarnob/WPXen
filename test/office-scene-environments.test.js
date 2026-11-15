import { describe, expect, it } from 'vitest';
import {
  CALM,
  DEFAULT_ENVIRONMENT,
  ENVIRONMENTS,
  ENVIRONMENT_IDS,
  blendLook,
  environmentById,
  environmentLook,
} from '../src/lib/office/scene/environments.js';
import { daylightAt } from '../src/lib/office/scene/daylight.js';
import { SETTINGS, createSettings } from '../electron/services/settings.cjs';

// The Office's environments (Settings → Office) and the look each one lights
// the room with. The worlds themselves are reviewed in the dev sandbox; these
// pin the catalogue and the lighting model behind them.

const HEX = /^#[0-9a-f]{6}$/;
const COLOUR_KEYS = ['skyTop', 'skyHorizon', 'fog', 'sun', 'hemiSky', 'hemiGround'];

describe('office environments', () => {
  it('lists six environments with the city first and default', () => {
    expect(ENVIRONMENT_IDS).toEqual([
      'city',
      'space',
      'island',
      'underwater',
      'cyberpunk',
      'green',
    ]);
    expect(DEFAULT_ENVIRONMENT).toBe('city');
    for (const env of ENVIRONMENTS) {
      expect(env.name).toBeTruthy();
      expect(env.blurb).toBeTruthy();
      expect(env.reacts).toBeTruthy();
      expect(env.ambientFps).toBeGreaterThanOrEqual(0);
    }
  });

  it('falls back to the city for an unknown id', () => {
    expect(environmentById('nope').id).toBe('city');
    expect(environmentById(undefined).id).toBe('city');
  });

  it('lights the city exactly as the daylight model does', () => {
    expect(environmentLook('city', 13)).toEqual(daylightAt(13));
  });

  it('gives every environment a complete look at every hour', () => {
    for (const id of ENVIRONMENT_IDS)
      for (let h = 0; h < 24; h += 1.5) {
        const look = environmentLook(id, h, { live: 3, busy: 1, waiting: 1, error: 1 });
        for (const key of COLOUR_KEYS)
          expect(look[key], `${id} ${key} @${h}`).toMatch(HEX);
        expect(look.sunIntensity).toBeGreaterThan(0);
        expect(Math.hypot(...look.keyDir)).toBeCloseTo(1, 6);
        expect(look.keyDir[1]).toBeGreaterThan(0);
        for (const key of ['windows', 'stars', 'day']) {
          expect(look[key]).toBeGreaterThanOrEqual(0);
          expect(look[key]).toBeLessThanOrEqual(1);
        }
      }
  });

  it('rolls a storm over the island while an agent errors', () => {
    const calm = environmentLook('island', 13, CALM);
    const storm = environmentLook('island', 13, { ...CALM, live: 1, error: 1 });
    expect(storm.sunIntensity).toBeLessThan(calm.sunIntensity);
    expect(storm.skyTop).not.toBe(calm.skyTop);
  });

  it('keeps the cyberpunk city at night whatever the hour', () => {
    expect(environmentLook('cyberpunk', 12).windows).toBe(1);
    expect(environmentLook('cyberpunk', 12).day).toBe(0);
  });

  it('dims the sea as the day ends', () => {
    expect(environmentLook('underwater', 12.5).sunIntensity).toBeGreaterThan(
      environmentLook('underwater', 23).sunIntensity
    );
  });

  it('blends colours and numbers but keeps everything else', () => {
    const a = { skyTop: '#000000', sunIntensity: 0, phase: 'night', keyDir: [0, 1, 0] };
    const b = blendLook(a, { skyTop: '#ffffff', sunIntensity: 2, phase: 'x' }, 0.5);
    expect(b).toEqual({
      skyTop: '#808080',
      sunIntensity: 1,
      phase: 'night',
      keyDir: [0, 1, 0],
    });
  });

  it('matches the office.environment setting the main process validates', () => {
    expect(SETTINGS['office.environment'].values).toEqual(ENVIRONMENT_IDS);
    expect(SETTINGS['office.environment'].default).toBe(DEFAULT_ENVIRONMENT);
  });

  it('stores a chosen environment and refuses one that does not exist', () => {
    const data = {};
    const store = {
      get: (key, fallback) => (key in data ? data[key] : fallback),
      set: (key, value) => {
        data[key] = value;
      },
      delete: (key) => delete data[key],
    };
    const settings = createSettings({ store, schema: SETTINGS });
    expect(settings.write({ 'office.environment': 'island' }).ok).toBe(true);
    expect(data['settings.office.environment']).toBe('island');
    expect(settings.write({ 'office.environment': 'mars' }).ok).toBe(false);
    expect(data['settings.office.environment']).toBe('island');
  });
});
