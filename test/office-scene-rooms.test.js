import { describe, expect, it } from 'vitest';
import {
  ROOMS,
  officeInRoom,
  roomCounts,
  roomOf,
  roomTheme,
  waitingIn,
} from '../src/lib/office/scene/rooms.js';

function session(pid, state, extra = {}) {
  return {
    pid,
    sessionId: `s-${pid}`,
    cwd: '~/code/x',
    name: `x-${pid}`,
    state,
    projectKey: 'x',
    startedAt: pid,
    feed: [],
    ...extra,
  };
}

describe('office rooms', () => {
  it('declares the two rooms with their source themes', () => {
    expect(ROOMS.map((r) => r.kind)).toEqual(['claude', 'antigravity']);
    expect(ROOMS[0].name).toBe('Claude Code');
    expect(ROOMS[0].accent).toBe('#d97757');
    expect(ROOMS[1].accent).toBe('#4f7cff');
  });

  it('sessions without an agent kind default to the Claude room', () => {
    expect(roomOf({})).toBe('claude');
    expect(roomOf({ agent: 'antigravity' })).toBe('antigravity');
  });

  it('roomTheme falls back to the first room for unknown kinds', () => {
    expect(roomTheme('antigravity').kind).toBe('antigravity');
    expect(roomTheme('nope')).toBe(ROOMS[0]);
  });

  it('waitingIn counts waiting sessions and waiting interns', () => {
    const sessions = [
      session(1, 'waiting_on_user'),
      session(2, 'working', {
        subagents: {
          a: { subagentId: 'a', state: 'waiting_on_user' },
          b: { subagentId: 'b', state: 'working' },
        },
      }),
      session(3, 'idle'),
    ];
    expect(waitingIn(sessions)).toBe(2);
  });

  it('roomCounts derives each tab’s agent count and waiting-on-you count from the whole office', () => {
    const office = {
      sessions: {
        1: session(1, 'waiting_on_user'), // claude by default
        2: session(2, 'working', {
          // A waiting intern counts toward its room's waiting badge too.
          subagents: { a: { subagentId: 'a', state: 'waiting_on_user' } },
        }),
        [-1]: session(-1, 'working', { agent: 'antigravity' }),
        [-2]: session(-2, 'waiting_on_user', { agent: 'antigravity' }),
      },
      waitingCount: 3,
    };
    expect(roomCounts(office)).toEqual([
      { kind: 'claude', count: 2, waiting: 2 },
      { kind: 'antigravity', count: 2, waiting: 1 },
    ]);
    // An empty office still lists both rooms, at zero.
    expect(roomCounts({ sessions: {}, waitingCount: 0 })).toEqual([
      { kind: 'claude', count: 0, waiting: 0 },
      { kind: 'antigravity', count: 0, waiting: 0 },
    ]);
  });

  it('officeInRoom filters by room and recomputes the waiting count', () => {
    const office = {
      sessions: {
        1: session(1, 'waiting_on_user'), // claude by default
        2: session(2, 'waiting_on_user', { agent: 'antigravity' }),
        3: session(3, 'working', { agent: 'claude' }),
      },
      waitingCount: 2,
    };
    const claude = officeInRoom(office, 'claude');
    expect(Object.keys(claude.sessions)).toEqual(['1', '3']);
    expect(claude.waitingCount).toBe(1);
    const anti = officeInRoom(office, 'antigravity');
    expect(Object.keys(anti.sessions)).toEqual(['2']);
    expect(anti.waitingCount).toBe(1);
  });

  it('an ended session lingering in a room is not counted as live', () => {
    const office = {
      sessions: {
        1: session(1, 'working'),
        2: session(2, 'ended'),
        [-1]: session(-1, 'ended', { agent: 'antigravity' }),
      },
      waitingCount: 0,
    };
    expect(roomCounts(office)).toEqual([
      { kind: 'claude', count: 1, waiting: 0 },
      { kind: 'antigravity', count: 0, waiting: 0 },
    ]);
    const claude = officeInRoom(office, 'claude');
    // Still on the floor (it is shown ended), but not live.
    expect(Object.keys(claude.sessions)).toEqual(['1', '2']);
    expect(claude.liveCount).toBe(1);
    expect(officeInRoom(office, 'antigravity').liveCount).toBe(0);
  });
});
