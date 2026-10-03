import { describe, it, expect } from 'vitest';
import {
  addProject,
  removeProject,
  reorderProjects,
  pruneProjects,
} from '../electron/services/agentProjects.cjs';

describe('agent working set', () => {
  it('adds a site once', () => {
    const list = addProject([], 'a');
    expect(list).toEqual(['a']);
    expect(addProject(list, 'a')).toBe(list);
  });

  it('removes a site', () => {
    expect(removeProject(['a', 'b'], 'a')).toEqual(['b']);
    const list = ['a'];
    expect(removeProject(list, 'zzz')).toBe(list);
  });

  it('reorders, ignoring unknown ids and keeping omitted members', () => {
    expect(reorderProjects(['a', 'b', 'c'], ['c', 'x', 'a', 'c'])).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('prunes ids whose site is gone', () => {
    expect(pruneProjects(['a', 'b'], [{ id: 'b' }])).toEqual(['b']);
    const list = ['a'];
    expect(pruneProjects(list, [{ id: 'a' }])).toBe(list);
  });
});
