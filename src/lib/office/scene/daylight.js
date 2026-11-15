// ── Daylight ─────────────────────────────────────────────────
// The Office sits on a high floor of a city tower, lit by the viewer's own
// local clock: morning sun from the east (+x), noon from the south (+z, the
// camera side), golden hour from the west (−x, through the left-wall glass),
// and a night of dark sky, moonlight and lit windows. Pure: an hour in, a look
// out — the scene turns it into lights, sky and fog (World.jsx, OfficeScene's
// Lights). No location is known, so sunrise and sunset are fixed hours rather
// than real ephemeris; the look, not astronomy, is the point.

/** Hour the sun clears the horizon. */
export const SUNRISE = 6;
/** Hour it sets. */
export const SUNSET = 19;
/** Highest the noon sun climbs, in radians (~62°). */
const MAX_ELEVATION = (62 * Math.PI) / 180;
/**
 * Lowest the key light is allowed to sit, in radians (~9°). The real sun goes
 * lower at the edges of the day, but a grazing light turns every shadow into a
 * stripe across the whole floor.
 */
const MIN_LIGHT_ELEVATION = (9 * Math.PI) / 180;
/** Where the moon hangs: high in the south-west, so night shadows read like day's. */
const MOON_DIR = normalize([-0.45, 0.8, 0.4]);
/** Hours over which the key light swings between the sun and the moon. */
const HANDOVER = 1.5;

/**
 * The look at each keyframe hour. Colours are sRGB hex. `windows` is how much
 * of the city's glazing glows (0 by day, 1 at night), `stars` the star field's
 * opacity, `day` how much daylight falls on the city's own surfaces (it stays
 * a dark silhouette at night even though the office lights are on), `env` the
 * reflection strength.
 * @typedef {object} Look
 * @property {string} skyTop
 * @property {string} skyHorizon
 * @property {string} fog
 * @property {string} sun
 * @property {number} sunIntensity
 * @property {string} hemiSky
 * @property {string} hemiGround
 * @property {number} hemiIntensity
 * @property {number} ambient
 * @property {number} fill
 * @property {number} env
 * @property {number} windows
 * @property {number} stars
 * @property {number} day
 */

/** @type {ReadonlyArray<{ hour: number, phase: string, look: Look }>} */
export const KEYFRAMES = [
  {
    hour: 0,
    phase: 'night',
    look: {
      skyTop: '#070c1c',
      skyHorizon: '#18223d',
      fog: '#141d35',
      sun: '#9fb4ff',
      sunIntensity: 0.3,
      // The office lights are on: warm white from above, the city stays dark.
      hemiSky: '#fff0db',
      hemiGround: '#5a4a3a',
      hemiIntensity: 0.95,
      ambient: 0.22,
      fill: 0.08,
      env: 0.35,
      windows: 1,
      stars: 1,
      day: 0,
    },
  },
  {
    hour: 4.6,
    phase: 'night',
    look: {
      skyTop: '#070c1c',
      skyHorizon: '#18223d',
      fog: '#141d35',
      sun: '#9fb4ff',
      sunIntensity: 0.3,
      hemiSky: '#fff0db',
      hemiGround: '#5a4a3a',
      hemiIntensity: 0.95,
      ambient: 0.22,
      fill: 0.08,
      env: 0.35,
      windows: 1,
      stars: 1,
      day: 0,
    },
  },
  {
    hour: 6.2,
    phase: 'dawn',
    look: {
      skyTop: '#3d5289',
      skyHorizon: '#f0a582',
      fog: '#b99491',
      sun: '#ffb27c',
      sunIntensity: 1.1,
      hemiSky: '#ffe3cb',
      hemiGround: '#b39c86',
      hemiIntensity: 0.85,
      ambient: 0.2,
      fill: 0.2,
      env: 0.6,
      windows: 0.55,
      stars: 0.12,
      day: 0.5,
    },
  },
  {
    hour: 8,
    phase: 'morning',
    look: {
      skyTop: '#6aa0da',
      skyHorizon: '#d4e3ef',
      fog: '#c3d3e2',
      sun: '#fff0da',
      sunIntensity: 1.95,
      hemiSky: '#ffffff',
      hemiGround: '#d6c4a8',
      hemiIntensity: 1.05,
      ambient: 0.25,
      fill: 0.4,
      env: 1,
      windows: 0.08,
      stars: 0,
      day: 0.95,
    },
  },
  {
    hour: 12.5,
    phase: 'day',
    look: {
      skyTop: '#4f8ed6',
      skyHorizon: '#d8e7f3',
      fog: '#c9d9e7',
      sun: '#fff6ea',
      sunIntensity: 2.1,
      hemiSky: '#ffffff',
      hemiGround: '#d6c4a8',
      hemiIntensity: 1.15,
      ambient: 0.25,
      fill: 0.45,
      env: 1,
      windows: 0,
      stars: 0,
      day: 1,
    },
  },
  {
    hour: 16.2,
    phase: 'day',
    look: {
      skyTop: '#5a91d0',
      skyHorizon: '#e4e4df',
      fog: '#d2d6d8',
      sun: '#ffe9c9',
      sunIntensity: 2,
      hemiSky: '#fff8ee',
      hemiGround: '#d6c4a8',
      hemiIntensity: 1.1,
      ambient: 0.25,
      fill: 0.42,
      env: 1,
      windows: 0.04,
      stars: 0,
      day: 1,
    },
  },
  {
    hour: 18,
    phase: 'golden',
    look: {
      skyTop: '#5a6da6',
      skyHorizon: '#ffb47a',
      fog: '#dfab8c',
      sun: '#ffaa62',
      sunIntensity: 1.75,
      hemiSky: '#ffe2c2',
      hemiGround: '#c9a27e',
      hemiIntensity: 0.9,
      ambient: 0.22,
      fill: 0.3,
      env: 0.8,
      windows: 0.25,
      stars: 0,
      day: 0.78,
    },
  },
  {
    hour: 19.3,
    phase: 'dusk',
    look: {
      skyTop: '#252b58',
      skyHorizon: '#d9726a',
      fog: '#6c5470',
      sun: '#ff8d63',
      sunIntensity: 0.55,
      hemiSky: '#ffead1',
      hemiGround: '#6e5a4a',
      hemiIntensity: 0.9,
      ambient: 0.22,
      fill: 0.15,
      env: 0.5,
      windows: 0.85,
      stars: 0.35,
      day: 0.3,
    },
  },
  {
    hour: 20.6,
    phase: 'night',
    look: {
      skyTop: '#070c1c',
      skyHorizon: '#18223d',
      fog: '#141d35',
      sun: '#9fb4ff',
      sunIntensity: 0.3,
      hemiSky: '#fff0db',
      hemiGround: '#5a4a3a',
      hemiIntensity: 0.95,
      ambient: 0.22,
      fill: 0.08,
      env: 0.35,
      windows: 1,
      stars: 1,
      day: 0,
    },
  },
];

/** Midnight closes the loop with the same look it opened with. */
const LOOP = [...KEYFRAMES, { ...KEYFRAMES[0], hour: 24 }];

/** @param {number[]} v */
function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Eases a 0..1 blend so keyframes are passed through without a kink. */
function ease(t) {
  return t * t * (3 - 2 * t);
}

/** @param {string} hex */
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** @param {number[]} c */
function hex(c) {
  return `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

/** sRGB blend of two hex colours. */
export function mixHex(a, b, t) {
  const x = rgb(a);
  const y = rgb(b);
  return hex(x.map((v, i) => v + (y[i] - v) * t));
}

/** Wraps any number into [0, 24). */
export function wrapHour(hour) {
  // In-range hours pass through untouched: (h % 24 + 24) % 24 turns 6.2 into
  // 6.1999…, which would miss the keyframe at 6.2.
  if (hour >= 0 && hour < 24) return hour;
  return ((hour % 24) + 24) % 24;
}

/**
 * The sun's true direction (toward the sun, unit vector) and elevation in
 * radians: an arc from east through south to west between SUNRISE and SUNSET,
 * below the horizon outside it.
 * @param {number} hour
 */
export function sunPosition(hour) {
  const h = wrapHour(hour);
  const u = (h - SUNRISE) / (SUNSET - SUNRISE);
  const elevation = MAX_ELEVATION * Math.sin(Math.PI * u);
  const azimuth = Math.PI * Math.min(1, Math.max(0, u)); // 0 east (+x) → π west (−x)
  const flat = Math.cos(Math.max(elevation, 0));
  return {
    elevation,
    dir: normalize([
      Math.cos(azimuth) * flat,
      Math.sin(Math.max(elevation, 0)),
      Math.sin(azimuth) * flat,
    ]),
  };
}

/**
 * The key light's direction: the sun while it is up (never lower than
 * MIN_LIGHT_ELEVATION), the moon at night, and a gradual swing between them
 * across HANDOVER hours either side of sunrise and sunset, so shadows never
 * jump.
 * @param {number} hour
 * @returns {[number, number, number]}
 */
export function keyLightDir(hour) {
  const h = wrapHour(hour);
  const clampSun = (at) => {
    const { dir } = sunPosition(at);
    const flat = Math.hypot(dir[0], dir[2]) || 1;
    const el = Math.max(Math.asin(Math.min(1, dir[1])), MIN_LIGHT_ELEVATION);
    return [(dir[0] / flat) * Math.cos(el), Math.sin(el), (dir[2] / flat) * Math.cos(el)];
  };
  const blend = (from, to, t) => {
    const e = ease(Math.min(1, Math.max(0, t)));
    return normalize(from.map((v, i) => v + (to[i] - v) * e));
  };
  if (h >= SUNRISE && h <= SUNSET) return clampSun(h);
  if (h > SUNSET && h < SUNSET + HANDOVER)
    return blend(clampSun(SUNSET), MOON_DIR, (h - SUNSET) / HANDOVER);
  if (h < SUNRISE && h > SUNRISE - HANDOVER)
    return blend(MOON_DIR, clampSun(SUNRISE), (h - (SUNRISE - HANDOVER)) / HANDOVER);
  return MOON_DIR;
}

/**
 * The scene's lighting at a local hour: the keyframe look blended between its
 * two neighbours, the key light's direction, and the phase name (the
 * nearest keyframe at or before the hour).
 * @param {number} hour 0..24, fractions allowed; wraps.
 * @returns {Look & { hour: number, phase: string, keyDir: [number, number, number] }}
 */
export function daylightAt(hour) {
  const h = wrapHour(hour);
  let i = 0;
  while (i < LOOP.length - 2 && LOOP[i + 1].hour <= h) i++;
  const a = LOOP[i];
  const b = LOOP[i + 1];
  const t = ease((h - a.hour) / (b.hour - a.hour));
  /** @type {Record<string, string | number>} */
  const look = {};
  for (const key of Object.keys(a.look)) {
    const x = a.look[key];
    const y = b.look[key];
    look[key] = typeof x === 'string' ? mixHex(x, y, t) : x + (y - x) * t;
  }
  return {
    .../** @type {Look} */ (look),
    hour: h,
    phase: a.phase,
    keyDir: keyLightDir(h),
  };
}

/**
 * The local hour of a Date, minutes included, rounded down to the minute so
 * the scene re-lights at most once a minute.
 * @param {Date} date
 */
export function hourOf(date) {
  return date.getHours() + date.getMinutes() / 60;
}

/** Dev Preview presets: the four looks worth reviewing, by hour. */
export const PREVIEW_HOURS = {
  dawn: 6.6,
  day: 12.5,
  golden: 18,
  night: 22,
};
