import { describe, it, expect } from 'vitest';
import {
  EMPTY_WORKSPACE,
  workspaceReducer,
  activeTab,
  resolveContext,
  siteIdFromPath,
  folderName,
  terminalTabTitle,
  needsAttention,
} from '../src/lib/floatingWorkspace';

const term = (id, extra = {}) => ({
  kind: 'terminal',
  id,
  sessionId: `s-${id}`,
  cwd: '~',
  ...extra,
});

function withTabs(ids, activeId = ids.at(-1)) {
  const s = ids.reduce(
    (acc, id) => workspaceReducer(acc, { type: 'add', tab: term(id) }),
    EMPTY_WORKSPACE
  );
  return workspaceReducer(s, { type: 'activate', id: activeId });
}

describe('workspaceReducer', () => {
  it('adds a tab at the end and focuses it', () => {
    const s = withTabs(['a', 'b']);
    expect(s.tabs.map((t) => t.id)).toEqual(['a', 'b']);
    expect(s.activeId).toBe('b');
    expect(activeTab(s).id).toBe('b');
  });

  it('closing the focused tab focuses its right-hand neighbour', () => {
    const s = workspaceReducer(withTabs(['a', 'b', 'c'], 'b'), {
      type: 'close',
      id: 'b',
    });
    expect(s.tabs.map((t) => t.id)).toEqual(['a', 'c']);
    expect(s.activeId).toBe('c');
  });

  it('closing the last focused tab falls back to the left', () => {
    const s = workspaceReducer(withTabs(['a', 'b', 'c'], 'c'), {
      type: 'close',
      id: 'c',
    });
    expect(s.activeId).toBe('b');
  });

  it('closing a background tab keeps focus where it was', () => {
    const s = workspaceReducer(withTabs(['a', 'b', 'c'], 'a'), {
      type: 'close',
      id: 'c',
    });
    expect(s.activeId).toBe('a');
  });

  it('closing the only tab leaves an empty workspace', () => {
    const s = workspaceReducer(withTabs(['a']), { type: 'close', id: 'a' });
    expect(s).toEqual({ tabs: [], activeId: null });
    expect(activeTab(s)).toBeNull();
  });

  it('ignores closing or activating an unknown tab', () => {
    const s = withTabs(['a', 'b']);
    expect(workspaceReducer(s, { type: 'close', id: 'zz' })).toBe(s);
    expect(workspaceReducer(s, { type: 'activate', id: 'zz' })).toBe(s);
  });

  it('activates a tab', () => {
    const s = workspaceReducer(withTabs(['a', 'b']), { type: 'activate', id: 'a' });
    expect(s.activeId).toBe('a');
  });

  it('updates a tab in place, keeping its position and focus (Restart)', () => {
    const s = workspaceReducer(withTabs(['a', 'b'], 'a'), {
      type: 'update',
      id: 'a',
      patch: { sessionId: 'fresh' },
    });
    expect(s.tabs.map((t) => t.id)).toEqual(['a', 'b']);
    expect(s.tabs[0].sessionId).toBe('fresh');
    expect(s.activeId).toBe('a');
  });

  it('prunes terminal tabs whose Session is gone, moving focus on', () => {
    const s = workspaceReducer(withTabs(['a', 'b', 'c'], 'b'), {
      type: 'prune',
      sessionIds: ['s-a', 's-c'],
    });
    expect(s.tabs.map((t) => t.id)).toEqual(['a', 'c']);
    expect(s.activeId).toBe('c');
  });
});

describe('resolveContext', () => {
  const sites = [
    { id: 'shop', path: '/Users/me/Sites/shop', url: 'https://shop.test' },
    { id: 'my blog', path: '/Users/me/Sites/blog', url: 'http://blog.test' },
  ];

  it('uses the Site webroot and URL on a Site page', () => {
    expect(resolveContext({ pathname: '/sites/shop', sites })).toEqual({
      siteId: 'shop',
      cwd: '/Users/me/Sites/shop',
      url: 'https://shop.test',
    });
  });

  it('uses the Site on its Agents view, decoding the id', () => {
    expect(resolveContext({ pathname: '/agents/my%20blog', sites })).toMatchObject({
      siteId: 'my blog',
      cwd: '/Users/me/Sites/blog',
      url: 'http://blog.test',
    });
  });

  it('uses the Terminal Directory everywhere else', () => {
    for (const pathname of ['/dashboard', '/services', '/agents', '/settings/general']) {
      expect(resolveContext({ pathname, sites, terminalDirectory: '~/code' })).toEqual({
        siteId: null,
        cwd: '~/code',
        url: null,
      });
    }
  });

  it('falls back to ~ when no Terminal Directory is set', () => {
    expect(resolveContext({ pathname: '/php', sites }).cwd).toBe('~');
    expect(resolveContext({ pathname: '/php', sites, terminalDirectory: '' }).cwd).toBe(
      '~'
    );
  });

  it('falls back when the routed Site no longer exists', () => {
    expect(resolveContext({ pathname: '/sites/gone', sites })).toMatchObject({
      siteId: null,
      cwd: '~',
    });
  });

  it('reads the Site id from nested Site routes', () => {
    expect(siteIdFromPath('/sites/shop/logs')).toBe('shop');
    expect(siteIdFromPath('/sitesx/shop')).toBeNull();
  });
});

describe('labels', () => {
  it('names a folder by its last segment', () => {
    expect(folderName('/Users/me/Sites/shop/')).toBe('shop');
    expect(folderName('~')).toBe('~');
    expect(folderName('/')).toBe('/');
  });

  it('prefers the shell title, then the folder', () => {
    const tab = term('a', { cwd: '/Users/me/Sites/shop' });
    expect(terminalTabTitle(tab, { title: 'vim index.php' })).toBe('vim index.php');
    expect(terminalTabTitle(tab, { title: '  ' })).toBe('shop');
    expect(terminalTabTitle(tab, null)).toBe('shop');
  });
});

describe('needsAttention', () => {
  it('is set by an unread or needs-input live Session', () => {
    expect(needsAttention([{ unread: true }])).toBe(true);
    expect(needsAttention([{ state: 'needs-input' }])).toBe(true);
    expect(needsAttention([{ state: 'working' }, { state: 'idle' }])).toBe(false);
    expect(needsAttention([{ unread: true, exited: true }])).toBe(false);
    expect(needsAttention([])).toBe(false);
  });
});
