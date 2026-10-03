import { describe, it, expect } from 'vitest';
import {
  addProject,
  removeProject,
  reorderProjects,
  pruneProjects,
  FOLDER_ID_PREFIX,
  isFolderId,
  folderProject,
  projectIdForPath,
  projectRecords,
} from '../electron/services/agentProjects.cjs';
import {
  FOLDER_ID_PREFIX as RENDERER_PREFIX,
  isFolderProject,
} from '../src/lib/agentsList.js';

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

describe('folder projects', () => {
  it('makes a folder record named after the folder, with a prefixed id', () => {
    expect(folderProject('/Users/me/code/api/', 'abc')).toEqual({
      id: `${FOLDER_ID_PREFIX}abc`,
      kind: 'folder',
      name: 'api',
      path: '/Users/me/code/api',
    });
  });

  it('tells folder ids from Site ids', () => {
    expect(isFolderId(`${FOLDER_ID_PREFIX}abc`)).toBe(true);
    expect(isFolderId('my-site')).toBe(false);
    expect(isFolderId(undefined)).toBe(false);
  });

  it('keeps the renderer copy of the prefix in sync', () => {
    expect(RENDERER_PREFIX).toBe(FOLDER_ID_PREFIX);
    expect(isFolderProject(`${FOLDER_ID_PREFIX}abc`)).toBe(true);
    expect(isFolderProject('my-site')).toBe(false);
  });

  it("finds a project already rooted at a folder, a Site's first", () => {
    const sites = [{ id: 'shop', path: '/Users/me/Sites/shop' }];
    const folders = [{ id: 'folder-1', path: '/Users/me/code/api' }];
    expect(projectIdForPath('/Users/me/Sites/shop/', sites, folders)).toBe('shop');
    expect(projectIdForPath('/Users/me/code/api', sites, folders)).toBe('folder-1');
    expect(projectIdForPath('/Users/me/code/other', sites, folders)).toBe(null);
  });

  it('tags every record with its kind, and prunes against both lists', () => {
    const records = projectRecords([{ id: 'shop' }], [{ id: 'folder-1' }]);
    expect(records.map((r) => [r.id, r.kind])).toEqual([
      ['shop', 'site'],
      ['folder-1', 'folder'],
    ]);
    expect(pruneProjects(['shop', 'folder-1', 'folder-gone'], records)).toEqual([
      'shop',
      'folder-1',
    ]);
  });
});
