import { describe, it, expect } from 'vitest';
import { buildProjects, sessionTitle } from '../src/lib/agentsList';

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
