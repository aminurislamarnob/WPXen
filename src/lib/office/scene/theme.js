// ── Design tokens shared by the 3D scene ─────────────────────
// One palette keeps characters, furniture and labels cohesive. Ported
// pixel-faithful from claude-agent-verse (web/src/scene/theme.ts); the scene's
// art direction is deliberately NOT re-tokenized onto WPXen's semantic tokens
// (spec #178 visual split) — do not swap these for CSS variables.

export const palette = {
  floor: '#d9c7ac',
  floorPlank: '#cdb999',
  wall: '#f1eee8',
  wallTrim: '#e2ddd3',
  concrete: '#c9c6c0',
  deskTop: '#e9e2d6',
  deskTopDark: '#2a2b30',
  deskLeg: '#2b2d33',
  aluminum: '#c8ccd2',
  aluminumDark: '#9097a0',
  spaceGray: '#4a4d55',
  screenBezel: '#121316',
  keycap: '#f4f2ee',
  keycapAccent: '#d97757',
  keyboardBase: '#3a3d45',
  chair: '#2f3138',
  chairMesh: '#3d4049',
  plantLeaf: '#4f8a5b',
  plantLeafLight: '#6fae75',
  pot: '#efe9df',
  potDark: '#3b3d44',
  fabric: '#7d8597',
  fabricWarm: '#c9a27e',
  rug: '#e6ded1',
  accent: '#d97757',
  ink: '#1d1f24',
};

/** @type {Record<string, string>} one colour per Agent State */
export const stateColor = {
  working: '#3b82f6',
  thinking: '#8b5cf6',
  waiting_on_user: '#f59e0b',
  idle: '#10b981',
  error: '#ef4444',
  ended: '#94a3b8',
};

export const stateLabel = {
  working: 'Working',
  thinking: 'Thinking',
  waiting_on_user: 'Waiting on you',
  idle: 'Idle',
  error: 'Error',
  ended: 'Ended',
};

// ── Deterministic variety ────────────────────────────────────

/** FNV-1a over the string, as an unsigned 32-bit int. */
export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function pick(list, seed, salt = 0) {
  return list[((seed + Math.imul(salt + 1, 2654435761)) >>> 0) % list.length];
}

/** Team colour for a project pod: muted, premium hues that sit well on warm neutrals. */
const teamHues = [
  '#5b6cff',
  '#d97757',
  '#14a38b',
  '#c2549d',
  '#e0a526',
  '#3c8dde',
  '#7a5cf0',
  '#4c9a5f',
];
export function teamColor(projectKey) {
  return pick(teamHues, hash(projectKey));
}

const skinTones = ['#f6d7c3', '#eec1a0', '#d9a07c', '#b97a56', '#8d5a3c', '#f3cfb3'];
const hairColors = [
  '#2a211d',
  '#4a3426',
  '#7a4b2a',
  '#c48a4a',
  '#1d1d22',
  '#a14b3a',
  '#d9c6a5',
];
const thobeColors = ['#f6f4ef', '#ece5d8', '#dde2e6', '#e9e4dc'];
const hoodieColors = [
  '#2f3440',
  '#e8e4dc',
  '#5b6cff',
  '#d97757',
  '#14a38b',
  '#9aa3b5',
  '#262a33',
  '#c2549d',
];

const hairStyles = ['crop', 'bun', 'curly', 'bob', 'swoop', 'buzz'];

/**
 * A stable appearance derived from an id so a session keeps its look across
 * reloads.
 *
 * @typedef {object} Look
 * @property {string} skin
 * @property {string} hair
 * @property {'crop'|'bun'|'curly'|'bob'|'swoop'|'buzz'} hairStyle
 * @property {string} top
 * @property {'hoodie'|'thobe'} attire Hoodie and trousers, or a thobe (long robe) with sandals.
 * @property {boolean} prayerCap Taqiyah prayer cap.
 * @property {boolean} beard Full Sunnah beard.
 * @property {boolean} glasses
 * @property {boolean} headphones
 * @property {boolean} beanie
 *
 * @param {string} id
 * @param {{ intern?: boolean }} [opts]
 * @returns {Look}
 */
export function lookFor(id, opts = {}) {
  const s = hash(id);
  // About one developer in five wears a thobe, prayer cap and Sunnah beard.
  const traditional = !opts.intern && (s >>> 13) % 5 === 0;
  return {
    skin: pick(skinTones, s, 1),
    hair: pick(hairColors, s, 2),
    hairStyle: traditional ? 'buzz' : pick(hairStyles, s, 3),
    top: traditional ? pick(thobeColors, s, 14) : pick(hoodieColors, s, 4),
    attire: traditional ? 'thobe' : 'hoodie',
    prayerCap: traditional,
    beard: traditional,
    glasses: (s >>> 5) % 3 === 0,
    headphones: !opts.intern && !traditional && (s >>> 7) % 4 === 0,
    beanie: !!opts.intern,
  };
}
