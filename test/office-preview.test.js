import { describe, expect, it, vi } from 'vitest';
import { STATES, build, subscribePreview } from '../src/lib/office/preview.js';
import { officeInRoom } from '../src/lib/office/scene/rooms.js';

// The dev Preview feeds synthetic snapshots straight to the scene (never the
// engine). These invariants are what make it a complete review harness: over a
// full cycle, the cycling desks pass through every Agent State.

const ALL_STATES = ['working', 'thinking', 'waiting_on_user', 'idle', 'error', 'ended'];

describe('preview office', () => {
  it('cycles through every Agent State across ticks', () => {
    expect([...STATES].sort()).toEqual([...ALL_STATES].sort());
    const seen = new Set();
    for (let tick = 0; tick < STATES.length; tick++) {
      for (const s of Object.values(build(tick).sessions)) seen.add(s.state);
    }
    for (const state of ALL_STATES) expect(seen.has(state)).toBe(true);
  });

  it('is deterministic for a given tick', () => {
    expect(build(3)).toEqual(build(3));
  });

  it('waitingCount matches the sessions waiting on you', () => {
    for (const tick of [0, 1, 5, 9]) {
      const office = build(tick);
      const waiting = Object.values(office.sessions).filter(
        (s) => s.state === 'waiting_on_user'
      ).length;
      expect(office.waitingCount).toBe(waiting);
    }
  });

  it('populates the Claude room with pod-grouped sessions', () => {
    const claude = officeInRoom(build(0), 'claude');
    const sessions = Object.values(claude.sessions);
    expect(sessions.length).toBeGreaterThanOrEqual(10);
    const projects = new Set(sessions.map((s) => s.projectKey));
    expect(projects.size).toBeGreaterThanOrEqual(5);
    for (const s of sessions) {
      expect(typeof s.pid).toBe('number');
      expect(s.name).toBeTruthy();
      expect(typeof s.startedAt).toBe('number');
      expect(ALL_STATES).toContain(s.state);
      // The current-tool label has something to show whenever a desk works.
      if (s.state === 'working') expect(s.currentTool).toBeTruthy();
      else expect(s.currentTool).toBeUndefined();
    }
  });

  it('gives error desks an error feed entry', () => {
    for (const s of Object.values(build(0).sessions)) {
      if (s.state === 'error') {
        expect(s.feed.at(-1).type).toBe('error');
      }
    }
  });

  it('subscribePreview emits immediately, ticks in cycle mode, freezes in still mode', () => {
    vi.useFakeTimers();
    try {
      const cycled = [];
      const stop = subscribePreview((o) => cycled.push(o), 'cycle');
      expect(cycled).toHaveLength(1);
      vi.advanceTimersByTime(4000);
      expect(cycled).toHaveLength(2);
      expect(cycled[1]).not.toEqual(cycled[0]); // the cycling desks moved on
      stop();
      vi.advanceTimersByTime(20000);
      expect(cycled).toHaveLength(2);

      const still = [];
      const stopStill = subscribePreview((o) => still.push(o), 'still');
      vi.advanceTimersByTime(20000);
      expect(still).toHaveLength(1);
      stopStill();
    } finally {
      vi.useRealTimers();
    }
  });
});
