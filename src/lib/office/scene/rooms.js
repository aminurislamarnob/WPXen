import { palette } from './theme.js';

// ── Rooms ────────────────────────────────────────────────────
// One room per kind of agent, shown one at a time. Rooms share the floor plan
// and furniture; the name, accent and wall colour make it obvious which one
// you're in. Ported whole from the source scene; the Office page's room tabs
// switch between them and show each room's counts (roomCounts).

/**
 * @typedef {object} RoomTheme
 * @property {'claude'|'antigravity'} kind
 * @property {string} name
 * @property {string} accent
 * @property {string} neon Glow of the neon sign; brighter than the accent.
 * @property {string} wall
 * @property {string} hint Shown in an empty room.
 */

/** @type {readonly RoomTheme[]} */
export const ROOMS = [
  {
    kind: 'claude',
    name: 'Claude Code',
    accent: palette.accent,
    neon: '#ff8a5c',
    wall: palette.wall,
    hint: 'Start a Claude Code session and its agent will walk in within a second.',
  },
  {
    kind: 'antigravity',
    name: 'Antigravity',
    accent: '#4f7cff',
    neon: '#7aa2ff',
    wall: '#e6ebf3',
    hint: 'Start a conversation in Antigravity and its agent will walk in within a second.',
  },
];

export function roomOf(session) {
  return session.agent ?? 'claude';
}

export function roomTheme(kind) {
  return ROOMS.find((r) => r.kind === kind) ?? ROOMS[0];
}

/** Agents waiting on you, interns included, as the engine counts them. */
export function waitingIn(sessions) {
  let n = 0;
  for (const s of sessions) {
    if (s.state === 'waiting_on_user') n++;
    for (const sub of Object.values(s.subagents ?? {}))
      if (sub.state === 'waiting_on_user') n++;
  }
  return n;
}

/**
 * Sessions still running. An ended one lingers on the floor for a few seconds
 * so it is seen to end (ENDED_LINGER_MS in the engine), but it is not live.
 */
function liveIn(sessions) {
  return sessions.filter((s) => s.state !== 'ended').length;
}

/**
 * One entry per room, from the whole office: the live agent count and the
 * waiting-on-you count its tab shows. Tabs always count every room, whichever
 * one is on screen.
 * @returns {{ kind: string, count: number, waiting: number }[]}
 */
export function roomCounts(office) {
  const all = Object.values(office.sessions);
  return ROOMS.map((room) => {
    const sessions = all.filter((s) => roomOf(s) === room.kind);
    return { kind: room.kind, count: liveIn(sessions), waiting: waitingIn(sessions) };
  });
}

/** The part of the office that sits in one room, ended sessions included. */
export function officeInRoom(office, kind) {
  const sessions = Object.values(office.sessions).filter((s) => roomOf(s) === kind);
  return {
    sessions: Object.fromEntries(sessions.map((s) => [s.pid, s])),
    waitingCount: waitingIn(sessions),
    liveCount: liveIn(sessions),
  };
}
