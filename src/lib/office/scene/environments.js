import { daylightAt, mixHex, wrapHour } from './daylight.js';

// ── Environments ─────────────────────────────────────────────
// Where the Office stands, chosen in Settings → Office (`office.environment`).
// Every environment wraps the same room; what changes is the world around it,
// its light, and how that world reacts to the agents (scene/environments/*).
// Pure: this module names the environments and turns (environment, local
// hour, agent mood) into the same Look shape daylight.js produces, so the
// scene's lights, sky and fog never need to know which world they're in.

/** How far the camera sits from what it looks at; every fog range is tied to it. */
export const CAMERA_DISTANCE = 220;

/**
 * @typedef {object} EnvironmentInfo
 * @property {string} id
 * @property {string} name
 * @property {string} blurb One line for the Settings picker.
 * @property {string} reacts How the world answers the agents, for the picker.
 * @property {number} ambientFps Frames per second the scenery needs to keep
 *   moving (waves, rain, fish) while nothing else is animating; 0 for a still
 *   world. The scene renders at max(this, its own pacing).
 */

/** @type {ReadonlyArray<EnvironmentInfo>} */
export const ENVIRONMENTS = [
  {
    id: 'city',
    name: 'City high-rise',
    blurb: 'The top floor of a glass tower above a city, lit by your local time.',
    reacts: 'Day turns to night with your clock; the city lights up after dark.',
    ambientFps: 0,
  },
  {
    id: 'space',
    name: 'Space station',
    blurb: 'An orbital deck with the Earth turning below, in step with your local time.',
    reacts: 'A shuttle docks for each session; a shooting star marks a finished task.',
    ambientFps: 15,
  },
  {
    id: 'island',
    name: 'Tropical island',
    blurb: 'An open-air pavilion on a beach, with waves rolling in and palms swaying.',
    reacts:
      'A boat sails in for each session; storm clouds gather while an agent errors.',
    ambientFps: 20,
  },
  {
    id: 'underwater',
    name: 'Underwater dome',
    blurb: 'A research dome on the sea floor, light rippling down from the surface.',
    reacts: 'Fish gather around busy desks; bubbles rise from an agent waiting on you.',
    ambientFps: 20,
  },
  {
    id: 'cyberpunk',
    name: 'Neon rooftop',
    blurb: 'A rain-soaked rooftop in a neon city at night, with flying-car traffic.',
    reacts: 'Each project lights its own neon sign; lightning flashes on an error.',
    ambientFps: 24,
  },
  {
    id: 'green',
    name: 'Green view',
    blurb: 'A glass pavilion in a garden among trees and hills, lit by your local time.',
    reacts:
      'A bird flies in for each session; flowers bloom as agents finish their work.',
    ambientFps: 12,
  },
];

export const DEFAULT_ENVIRONMENT = 'city';

/** Environment ids, in Settings order — the `office.environment` enum. */
export const ENVIRONMENT_IDS = ENVIRONMENTS.map((e) => e.id);

/** @param {string | undefined} id */
export function environmentById(id) {
  return ENVIRONMENTS.find((e) => e.id === id) ?? ENVIRONMENTS[0];
}

/**
 * How the agents are doing, as far as the world's mood is concerned.
 * @typedef {object} Mood
 * @property {number} live
 * @property {number} busy
 * @property {number} waiting
 * @property {number} error
 */

/** @type {Mood} */
export const CALM = { live: 0, busy: 0, waiting: 0, error: 0 };

const normalize = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return /** @type {[number, number, number]} */ ([v[0] / l, v[1] / l, v[2] / l]);
};

/** Blends two looks: colours in sRGB, numbers linearly; the base keeps its hour, phase and key light. */
export function blendLook(base, over, t) {
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const from = base[key];
    if (typeof value === 'string' && typeof from === 'string' && from.startsWith('#'))
      out[key] = mixHex(from, value, t);
    else if (typeof value === 'number' && typeof from === 'number')
      out[key] = from + (value - from) * t;
  }
  return out;
}

/** A tropical squall: grey sky, a dimmed sun, flat light. */
const STORM = {
  skyTop: '#3b4552',
  skyHorizon: '#7d8790',
  fog: '#6e7880',
  sun: '#c9d2dc',
  sunIntensity: 0.55,
  hemiSky: '#d5dde6',
  hemiIntensity: 0.95,
  ambient: 0.32,
  fill: 0.2,
  env: 0.55,
};

/**
 * The look of an environment at a local hour, given the agents' mood.
 * @param {string} id
 * @param {number} hour
 * @param {Mood} [mood]
 * @returns {ReturnType<typeof daylightAt>}
 */
export function environmentLook(id, hour, mood = CALM) {
  const h = wrapHour(hour);
  const day = daylightAt(h);
  switch (id) {
    case 'island': {
      // Brighter, warmer, a turquoise horizon; a squall while any agent errors.
      const tropical = blendLook(
        day,
        {
          skyHorizon: day.day > 0.5 ? '#bfe9ef' : day.skyHorizon,
          fog: day.day > 0.5 ? '#b9e3ea' : day.fog,
          hemiGround: '#e6d3a8',
        },
        0.7 * day.day
      );
      return mood.error > 0 ? blendLook(tropical, STORM, 0.75) : tropical;
    }
    case 'green':
      // Light bounced off grass and leaves, a soft green-blue haze.
      return blendLook(
        day,
        {
          hemiGround: '#8fae76',
          fog: day.day > 0.5 ? '#cfe0d2' : day.fog,
          skyHorizon: day.day > 0.5 ? '#dcebe2' : day.skyHorizon,
        },
        0.75 * day.day
      );
    case 'space':
      // No weather and no sky: hard sunlight from one side, the station's own
      // lights inside, Earth-glow from below. The hour only turns the planet.
      return {
        ...day,
        phase: 'orbit',
        skyTop: '#010208',
        skyHorizon: '#04060f',
        fog: '#04060f',
        sun: '#ffffff',
        sunIntensity: 2.6,
        hemiSky: '#cfe0ff',
        hemiGround: '#3e5a86',
        hemiIntensity: 0.6,
        ambient: 0.2,
        fill: 0.35,
        env: 0.6,
        windows: 1,
        stars: 1,
        day: 0,
        keyDir: normalize([-0.62, 0.55, 0.56]),
      };
    case 'underwater': {
      // Light comes down from the surface, dimming to a deep blue at night;
      // the dome's lamps keep the office warm.
      const sun = day.day;
      return {
        ...day,
        phase: 'deep',
        skyTop: mixHex('#021827', '#0b5f86', sun),
        skyHorizon: mixHex('#03202f', '#0d6f8a', sun),
        fog: mixHex('#021a27', '#0b5a72', sun),
        sun: '#bfeaff',
        sunIntensity: 0.45 + 1.15 * sun,
        hemiSky: mixHex('#ffe9cf', '#d6f3ff', sun),
        hemiGround: '#24505c',
        hemiIntensity: 0.95,
        ambient: 0.24,
        fill: 0.25,
        env: 0.55,
        windows: 1 - sun * 0.7,
        stars: 0,
        day: 0.25 + 0.55 * sun,
        keyDir: normalize([0.12, 1, 0.18]),
      };
    }
    case 'cyberpunk':
      // Always night, always raining: violet sky glow, magenta and cyan bounce.
      return {
        ...day,
        phase: 'neon',
        skyTop: '#07041a',
        skyHorizon: '#2b0f45',
        fog: '#1d0c33',
        sun: '#9c8cff',
        sunIntensity: 0.4,
        hemiSky: '#ffe6f6',
        hemiGround: '#3a1d5c',
        hemiIntensity: 0.95,
        ambient: 0.24,
        fill: 0.18,
        env: 0.5,
        windows: 1,
        stars: 0,
        day: 0,
        keyDir: normalize([-0.45, 0.8, 0.4]),
      };
    default:
      return day;
  }
}
