import { describe, expect, it } from 'vitest';
import {
  EVENT_TTL_MS,
  diffAgents,
  officeMood,
  pushEvents,
  stickySlots,
} from '../src/lib/office/agentEvents.js';

// The moments the Office's environments react to — arrivals, departures,
// finished turns, errors, waits — derived from consecutive snapshots.

const office = (states) => ({
  sessions: Object.fromEntries(
    Object.entries(states).map(([pid, state]) => [pid, { state }])
  ),
});

describe('office agent events', () => {
  it('says nothing about the first snapshot', () => {
    expect(diffAgents(null, office({ 1: 'working' }))).toEqual([]);
  });

  it('reports arrivals and departures, including a pid dropped outright', () => {
    const events = diffAgents(
      office({ 1: 'working', 2: 'idle' }),
      office({ 1: 'ended', 3: 'thinking' })
    );
    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'left', pid: 1 },
        { type: 'arrived', pid: 3 },
        { type: 'left', pid: 2 },
      ])
    );
    expect(events).toHaveLength(3);
  });

  it('treats a pid reused after an ended linger as a new arrival', () => {
    expect(diffAgents(office({ 1: 'ended' }), office({ 1: 'thinking' }))).toEqual([
      { type: 'arrived', pid: 1 },
    ]);
  });

  it('reports a finished turn, an error and a wait', () => {
    expect(diffAgents(office({ 1: 'working' }), office({ 1: 'idle' }))).toEqual([
      { type: 'finished', pid: 1 },
    ]);
    expect(diffAgents(office({ 1: 'thinking' }), office({ 1: 'idle' }))).toEqual([
      { type: 'finished', pid: 1 },
    ]);
    expect(diffAgents(office({ 1: 'working' }), office({ 1: 'error' }))).toEqual([
      { type: 'error', pid: 1 },
    ]);
    expect(
      diffAgents(office({ 1: 'working' }), office({ 1: 'waiting_on_user' }))
    ).toEqual([{ type: 'waiting', pid: 1 }]);
  });

  it('stays quiet when nothing changed, or idle merely continues', () => {
    expect(diffAgents(office({ 1: 'idle' }), office({ 1: 'idle' }))).toEqual([]);
    expect(diffAgents(office({ 1: 'error' }), office({ 1: 'idle' }))).toEqual([]);
  });

  it('counts the standing mood of a room, ended sessions excluded', () => {
    expect(
      officeMood(
        office({
          1: 'working',
          2: 'thinking',
          3: 'waiting_on_user',
          4: 'error',
          5: 'ended',
        })
      )
    ).toEqual({ live: 4, busy: 2, waiting: 1, error: 1 });
  });

  it('keeps slots sticky and reuses freed ones', () => {
    const a = stickySlots(new Map(), [10, 20, 30]);
    expect([...a]).toEqual([
      [10, 0],
      [20, 1],
      [30, 2],
    ]);
    const b = stickySlots(a, [10, 30, 40]);
    expect(b.get(10)).toBe(0);
    expect(b.get(30)).toBe(2);
    expect(b.get(40)).toBe(1);
  });

  it('gives no slot past capacity', () => {
    const slots = stickySlots(new Map(), [1, 2, 3], 2);
    expect(slots.size).toBe(2);
    expect(slots.has(3)).toBe(false);
  });

  it('stamps new events and drops expired ones', () => {
    const q1 = pushEvents([], [{ type: 'arrived', pid: 1 }], 1000, 1);
    expect(q1).toEqual([{ type: 'arrived', pid: 1, id: 1, at: 1000 }]);
    const q2 = pushEvents(q1, [{ type: 'left', pid: 2 }], 1000 + EVENT_TTL_MS, 2);
    expect(q2).toEqual([{ type: 'left', pid: 2, id: 2, at: 1000 + EVENT_TTL_MS }]);
  });
});
