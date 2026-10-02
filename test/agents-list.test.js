import { describe, it, expect } from 'vitest';
import {
  buildProjects,
  sessionTitle,
  formatAge,
  mostUrgent,
  buildActivity,
} from '../src/lib/agentsList';

const site = (id, name = id) => ({ id, name });
let seq = 0;
const session = (siteId, agentId, extra = {}) => ({
  sessionId: `s${++seq}`,
  siteId,
  agentId,
  agentName: agentId === 'claude' ? 'Claude' : 'Codex',
  label: null,
  title: '',
  startedAt: seq,
  exited: false,
  ...extra,
});

describe('buildProjects', () => {
  it('keeps the working-set order, not the sites order', () => {
    const rows = buildProjects({
      projectIds: ['b', 'a'],
      sites: [site('a'), site('b'), site('c')],
      sessions: [],
    });
    expect(rows.map((r) => r.site.id)).toEqual(['b', 'a']);
  });

  it('skips working-set ids whose site no longer exists', () => {
    const rows = buildProjects({
      projectIds: ['gone', 'a'],
      sites: [site('a')],
      sessions: [],
    });
    expect(rows.map((r) => r.site.id)).toEqual(['a']);
  });

  it('groups sessions under their site in launch order, including exited ones', () => {
    const late = session('a', 'claude', { startedAt: 100 });
    const early = session('a', 'codex', { startedAt: 1, exited: true });
    const other = session('b', 'claude');
    const rows = buildProjects({
      projectIds: ['a', 'b'],
      sites: [site('a'), site('b')],
      sessions: [late, other, early],
    });
    expect(rows[0].sessions.map((s) => s.sessionId)).toEqual([
      early.sessionId,
      late.sessionId,
    ]);
    expect(rows[1].sessions.map((s) => s.sessionId)).toEqual([other.sessionId]);
  });

  it('does not list sessions of sites outside the working set', () => {
    const rows = buildProjects({
      projectIds: ['a'],
      sites: [site('a'), site('b')],
      sessions: [session('b', 'claude')],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].sessions).toEqual([]);
  });
});

describe('sessionTitle', () => {
  it('prefers the terminal title', () => {
    const s = session('a', 'claude', { title: 'Fix checkout tax', label: 'Plugin' });
    expect(sessionTitle(s, [s])).toBe('Fix checkout tax');
  });

  it('falls back to the launch target label', () => {
    const s = session('a', 'claude', { label: 'Plugin' });
    expect(sessionTitle(s, [s])).toBe('Plugin');
  });

  it('uses the bare provider name when it is the only one', () => {
    const s = session('a', 'claude');
    expect(sessionTitle(s, [s, session('a', 'codex')])).toBe('Claude');
  });

  it('numbers repeated providers in launch order', () => {
    const one = session('a', 'claude');
    const two = session('a', 'claude');
    expect(sessionTitle(one, [one, two])).toBe('Claude #1');
    expect(sessionTitle(two, [one, two])).toBe('Claude #2');
  });
});

describe('formatAge', () => {
  it('reads as now, minutes, hours, days', () => {
    expect(formatAge(5_000)).toBe('now');
    expect(formatAge(4 * 60_000)).toBe('4m');
    expect(formatAge(3 * 3_600_000 + 59 * 60_000)).toBe('3h');
    expect(formatAge(2 * 86_400_000)).toBe('2d');
  });

  it('never goes negative under clock skew', () => {
    expect(formatAge(-10_000)).toBe('now');
  });
});

describe('mostUrgent', () => {
  const st = (state) => ({ state });

  it('ranks needs-input over working over error over done over exited', () => {
    expect(mostUrgent([st('done'), st('needs-input'), st('working')])).toBe(
      'needs-input'
    );
    expect(mostUrgent([st('done'), st('working'), st('error')])).toBe('working');
    expect(mostUrgent([st('exited'), st('done'), st('error')])).toBe('error');
    expect(mostUrgent([st('exited'), st('done')])).toBe('done');
    expect(mostUrgent([st('idle'), st('exited')])).toBe('exited');
  });

  it('is null for a project with no sessions', () => {
    expect(mostUrgent([])).toBe(null);
  });
});

describe('buildActivity', () => {
  const row = (sessionId, state, changedAt) => ({ sessionId, state, changedAt });

  it('flattens every project, tagging rows with their site name', () => {
    const rows = buildActivity([
      { site: { id: 'a', name: 'Shop' }, sessions: [row('s1', 'done', 1)] },
      { site: { id: 'b', name: 'Blog' }, sessions: [row('s2', 'done', 2)] },
    ]);
    expect(rows.map((r) => [r.sessionId, r.siteName])).toEqual([
      ['s2', 'Blog'],
      ['s1', 'Shop'],
    ]);
  });

  it('puts needs-input first, then working, then the rest by recency', () => {
    const rows = buildActivity([
      {
        site: { id: 'a', name: 'Shop' },
        sessions: [
          row('old-done', 'done', 1),
          row('working', 'working', 2),
          row('new-exit', 'exited', 9),
          row('asking', 'needs-input', 0),
          row('mid-error', 'error', 5),
        ],
      },
    ]);
    expect(rows.map((r) => r.sessionId)).toEqual([
      'asking',
      'working',
      'new-exit',
      'mid-error',
      'old-done',
    ]);
  });
});
