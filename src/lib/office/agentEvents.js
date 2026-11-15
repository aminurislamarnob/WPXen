// ── Agent events ─────────────────────────────────────────────
// What the Office's world reacts to. The engine pushes whole snapshots; the
// environments (shuttles docking, boats sailing in, storms, blooming flowers)
// want moments: an agent arrived, left, finished its turn, hit an error, or
// started waiting on you. These are derived here by diffing consecutive
// snapshots of the room on screen, plus the standing mood (how many are busy,
// waiting, in error) that weather-like effects follow. Pure and DOM-free.

/** States in which an agent is mid-turn. */
const BUSY = new Set(['working', 'thinking']);

/**
 * @typedef {object} AgentEvent
 * @property {'arrived' | 'left' | 'finished' | 'error' | 'waiting'} type
 * @property {number} pid
 */

const live = (s) => !!s && s.state !== 'ended';

/**
 * The moments between two snapshots of a room. The first snapshot (prev null)
 * yields none: agents already there when the page opens are simply there.
 * @param {{ sessions: Record<number, { state: string }> } | null} prev
 * @param {{ sessions: Record<number, { state: string }> }} next
 * @returns {AgentEvent[]}
 */
export function diffAgents(prev, next) {
  if (!prev) return [];
  /** @type {AgentEvent[]} */
  const events = [];
  for (const [key, session] of Object.entries(next.sessions)) {
    const pid = Number(key);
    const before = prev.sessions[pid];
    if (live(session) && !live(before)) {
      events.push({ type: 'arrived', pid });
      continue;
    }
    if (live(before) && !live(session)) {
      events.push({ type: 'left', pid });
      continue;
    }
    if (!live(session) || !before) continue;
    if (session.state === before.state) continue;
    if (BUSY.has(before.state) && session.state === 'idle')
      events.push({ type: 'finished', pid });
    else if (session.state === 'error') events.push({ type: 'error', pid });
    else if (session.state === 'waiting_on_user') events.push({ type: 'waiting', pid });
  }
  for (const key of Object.keys(prev.sessions)) {
    const pid = Number(key);
    if (live(prev.sessions[pid]) && !(pid in next.sessions))
      events.push({ type: 'left', pid });
  }
  return events;
}

/**
 * The standing mood of a room: live, busy, waiting and erroring agents.
 * @param {{ sessions: Record<number, { state: string }> }} office
 */
export function officeMood(office) {
  const mood = { live: 0, busy: 0, waiting: 0, error: 0 };
  for (const s of Object.values(office.sessions)) {
    if (!live(s)) continue;
    mood.live++;
    if (BUSY.has(s.state)) mood.busy++;
    else if (s.state === 'waiting_on_user') mood.waiting++;
    else if (s.state === 'error') mood.error++;
  }
  return mood;
}

/**
 * Sticky slot numbers for the world objects that stand in for agents (a
 * docking port, a mooring, a perch): a pid keeps its slot for as long as it is
 * in the room, newcomers take the lowest free slot, and a departed pid frees
 * its slot for the next arrival. Returns a new map; `prev` is not mutated.
 * @param {Map<number, number>} prev pid → slot
 * @param {number[]} pids The pids in the room now, in arrival order.
 * @param {number} [capacity] Slots available; pids beyond it get none.
 * @returns {Map<number, number>}
 */
export function stickySlots(prev, pids, capacity = Infinity) {
  const next = new Map();
  const taken = new Set();
  for (const pid of pids) {
    const slot = prev.get(pid);
    if (slot !== undefined && slot < capacity) {
      next.set(pid, slot);
      taken.add(slot);
    }
  }
  let free = 0;
  for (const pid of pids) {
    if (next.has(pid)) continue;
    while (taken.has(free)) free++;
    if (free >= capacity) break;
    next.set(pid, free);
    taken.add(free);
  }
  return next;
}

/** How long an event stays playable for the world's animations. */
export const EVENT_TTL_MS = 9000;

/**
 * Appends fresh events (stamped with `now` and a running id) and drops the
 * ones past EVENT_TTL_MS.
 * @param {Array<AgentEvent & { id: number, at: number }>} queue
 * @param {AgentEvent[]} fresh
 * @param {number} now
 * @param {number} nextId
 */
export function pushEvents(queue, fresh, now, nextId) {
  const kept = queue.filter((e) => now - e.at < EVENT_TTL_MS);
  fresh.forEach((e, i) => kept.push({ ...e, id: nextId + i, at: now }));
  return kept;
}
