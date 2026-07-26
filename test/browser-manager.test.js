import { describe, it, expect, vi, beforeEach } from 'vitest';
import browser from '../electron/services/browser.cjs';

// The module reaches its guests through electron's `webContents` registry.
// These .cjs services load via Node's CJS loader, so vi.mock on `electron`
// never reaches them — swap the registry through the module's own seam instead
// (same approach as external-tools.test.js).
function fakeGuest(over = {}) {
  const listeners = new Map();
  return {
    destroyed: false,
    listeners,
    isDestroyed() {
      return this.destroyed;
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    off(event, handler) {
      const next = (listeners.get(event) || []).filter((h) => h !== handler);
      listeners.set(event, next);
    },
    emit(event, ...args) {
      for (const h of [...(listeners.get(event) || [])]) h(...args);
    },
    setBackgroundThrottling: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    loadURL: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    openDevTools: vi.fn(),
    canGoBack: () => false,
    canGoForward: () => false,
    ...over,
  };
}

// A keyDown chord as before-input-event delivers it.
function chord(key, over = {}) {
  return {
    type: 'keyDown',
    key,
    meta: true,
    control: false,
    shift: false,
    alt: false,
    ...over,
  };
}

let registry;
let menuTemplate;
const fromId = vi.fn((id) => registry.get(id) ?? null);
const popup = vi.fn();
const buildFromTemplate = vi.fn((template) => {
  menuTemplate = template;
  return { popup };
});
const writeText = vi.fn();
const openExternalSafely = vi.fn(() => true);

beforeEach(() => {
  registry = new Map();
  menuTemplate = null;
  for (const m of [fromId, popup, buildFromTemplate, writeText, openExternalSafely]) {
    m.mockClear();
  }
  browser.__setDeps({
    webContents: { fromId },
    Menu: { buildFromTemplate },
    clipboard: { writeText },
    openExternalSafely,
  });
  browser.unregisterAll();
  browser.setWindow(null);
});

// Register a guest and hand back both it and a send spy for renderer pushes.
function registered(tabKey = 'browser:1', id = 1, guest = fakeGuest()) {
  const send = vi.fn();
  browser.setWindow({ isDestroyed: () => false, webContents: { send } });
  registry.set(id, guest);
  browser.register(tabKey, id);
  return { guest, send };
}

const labels = () => menuTemplate.filter((i) => i.label).map((i) => i.label);
const item = (label) => menuTemplate.find((i) => i.label === label);

describe('register', () => {
  it('throttles background guests and denies popups', () => {
    const guest = fakeGuest();
    registry.set(7, guest);
    browser.register('browser:1', 7);

    expect(guest.setBackgroundThrottling).toHaveBeenCalledWith(true);
    expect(guest.setWindowOpenHandler).toHaveBeenCalledTimes(1);

    const handler = guest.setWindowOpenHandler.mock.calls[0][0];
    expect(handler({ url: 'https://example.com' })).toEqual({ action: 'deny' });
  });

  it('re-registering a new webContentsId points the tab at the new guest', () => {
    const first = fakeGuest();
    const second = fakeGuest();
    registry.set(1, first);
    registry.set(2, second);

    browser.register('browser:1', 1);
    browser.register('browser:1', 2);

    expect(browser.getWebContents('browser:1')).toBe(second);
    // Each guest is configured exactly once — no stacking on the old one.
    expect(first.setWindowOpenHandler).toHaveBeenCalledTimes(1);
    expect(second.setWindowOpenHandler).toHaveBeenCalledTimes(1);
  });

  it('is idempotent for an unchanged id', () => {
    const guest = fakeGuest();
    registry.set(1, guest);
    browser.register('browser:1', 1);
    browser.register('browser:1', 1);
    expect(browser.getWebContents('browser:1')).toBe(guest);
  });

  it('survives a guest that vanished before registration', () => {
    expect(() => browser.register('browser:1', 99)).not.toThrow();
    expect(browser.getWebContents('browser:1')).toBeNull();
  });

  it('emits new-window to the renderer when a popup is denied', () => {
    const send = vi.fn();
    browser.setWindow({ isDestroyed: () => false, webContents: { send } });
    const guest = fakeGuest();
    registry.set(1, guest);
    browser.register('browser:1', 1);

    const handler = guest.setWindowOpenHandler.mock.calls[0][0];
    handler({ url: 'https://example.com/docs' });
    expect(send).toHaveBeenCalledWith('browser-new-window', {
      tabKey: 'browser:1',
      url: 'https://example.com/docs',
    });

    // about:blank popups are noise, not a page the user asked for.
    send.mockClear();
    handler({ url: 'about:blank' });
    expect(send).not.toHaveBeenCalled();
  });

  it('does not send to a destroyed window', () => {
    const send = vi.fn();
    browser.setWindow({ isDestroyed: () => true, webContents: { send } });
    const guest = fakeGuest();
    registry.set(1, guest);
    browser.register('browser:1', 1);
    guest.setWindowOpenHandler.mock.calls[0][0]({ url: 'https://example.com' });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('getWebContents', () => {
  it('returns null for an unknown tab', () => {
    expect(browser.getWebContents('browser:nope')).toBeNull();
  });

  it('returns null once the guest is destroyed', () => {
    const guest = fakeGuest();
    registry.set(1, guest);
    browser.register('browser:1', 1);
    guest.destroyed = true;
    expect(browser.getWebContents('browser:1')).toBeNull();
  });
});

describe('unregister', () => {
  it('forgets the tab', () => {
    registry.set(1, fakeGuest());
    browser.register('browser:1', 1);
    browser.unregister('browser:1');
    expect(browser.getWebContents('browser:1')).toBeNull();
  });

  it('unregisterAll clears every tab', () => {
    registry.set(1, fakeGuest());
    registry.set(2, fakeGuest());
    browser.register('browser:1', 1);
    browser.register('browser:2', 2);
    browser.unregisterAll();
    expect(browser.getWebContents('browser:1')).toBeNull();
    expect(browser.getWebContents('browser:2')).toBeNull();
  });
});

describe('navigation', () => {
  it('sanitizes before loading', () => {
    const guest = fakeGuest();
    registry.set(1, guest);
    browser.register('browser:1', 1);

    expect(browser.navigate('browser:1', 'wpherd.test')).toBe(true);
    expect(guest.loadURL).toHaveBeenCalledWith('https://wpherd.test');
  });

  it('reports failure rather than throwing when the tab is gone', () => {
    expect(browser.navigate('browser:gone', 'wpherd.test')).toBe(false);
    expect(browser.reload('browser:gone')).toBe(false);
    expect(browser.openDevTools('browser:gone')).toBe(false);
  });

  it('hard reload ignores the cache', () => {
    const guest = fakeGuest();
    registry.set(1, guest);
    browser.register('browser:1', 1);

    browser.reload('browser:1');
    expect(guest.reload).toHaveBeenCalled();
    expect(guest.reloadIgnoringCache).not.toHaveBeenCalled();

    browser.reload('browser:1', true);
    expect(guest.reloadIgnoringCache).toHaveBeenCalled();
  });

  it('opens DevTools detached so the page keeps its space', () => {
    const guest = fakeGuest();
    registry.set(1, guest);
    browser.register('browser:1', 1);
    browser.openDevTools('browser:1');
    expect(guest.openDevTools).toHaveBeenCalledWith({ mode: 'detach' });
  });
});

const NO_EDIT = { canCopy: false, canPaste: false, canSelectAll: false };

describe('context menu', () => {
  it('offers link actions when the click was on a link', () => {
    const { guest, send } = registered();
    guest.emit(
      'context-menu',
      {},
      {
        linkURL: 'https://example.com/docs',
        pageURL: 'http://wpherd.test/',
        selectionText: '',
        editFlags: NO_EDIT,
      }
    );

    expect(labels()).toContain('Open Link in Default Browser');
    item('Open Link in Default Browser').click();
    expect(openExternalSafely).toHaveBeenCalledWith('https://example.com/docs');

    item('Open Link in New Tab').click();
    expect(send).toHaveBeenCalledWith('browser-new-window', {
      tabKey: 'browser:1',
      url: 'https://example.com/docs',
    });

    item('Copy Link Address').click();
    expect(writeText).toHaveBeenCalledWith('https://example.com/docs');

    // Page-level actions belong to the page, not to a link.
    expect(labels()).not.toContain('Copy Page URL');
    expect(popup).toHaveBeenCalled();
  });

  it('offers page actions when the click was not on a link', () => {
    const { guest } = registered();
    guest.emit(
      'context-menu',
      {},
      {
        linkURL: '',
        pageURL: 'http://wpherd.test/',
        selectionText: '',
        editFlags: NO_EDIT,
      }
    );

    expect(labels()).toContain('Copy Page URL');
    item('Copy Page URL').click();
    expect(writeText).toHaveBeenCalledWith('http://wpherd.test/');
    expect(item('Open Page in Default Browser').enabled).toBe(true);
  });

  it('disables page actions on a blank tab', () => {
    const { guest } = registered();
    guest.emit(
      'context-menu',
      {},
      {
        linkURL: '',
        pageURL: 'about:blank',
        selectionText: '',
        editFlags: NO_EDIT,
      }
    );
    expect(item('Copy Page URL').enabled).toBe(false);
    expect(item('Open Page in Default Browser').enabled).toBe(false);
  });

  it('only offers edit actions the selection actually supports', () => {
    const { guest } = registered();
    guest.emit(
      'context-menu',
      {},
      {
        linkURL: '',
        pageURL: 'http://wpherd.test/',
        selectionText: 'hello',
        editFlags: { canCopy: true, canPaste: false, canSelectAll: true },
      }
    );
    expect(labels()).toContain('Copy');
    expect(labels()).toContain('Select All');
    expect(labels()).not.toContain('Paste');
  });

  it('mirrors the real back/forward availability of the guest', () => {
    const guest = fakeGuest({ canGoBack: () => true, canGoForward: () => false });
    registered('browser:1', 1, guest);
    guest.emit(
      'context-menu',
      {},
      {
        linkURL: '',
        pageURL: 'http://wpherd.test/',
        selectionText: '',
        editFlags: NO_EDIT,
      }
    );
    expect(item('Back').enabled).toBe(true);
    expect(item('Forward').enabled).toBe(false);
  });
});

describe('key interception', () => {
  it('forwards the chords a focused page would otherwise swallow', () => {
    for (const key of ['w', 'r', 'b', '[', ']']) {
      const { guest, send } = registered();
      const event = { preventDefault: vi.fn() };
      guest.emit('before-input-event', event, chord(key));

      expect(event.preventDefault).toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith('browser-shortcut', { tabKey: 'browser:1', key });
      browser.unregisterAll();
    }
  });

  it('normalizes an uppercase key', () => {
    const { guest, send } = registered();
    guest.emit('before-input-event', { preventDefault: vi.fn() }, chord('W'));
    expect(send).toHaveBeenCalledWith('browser-shortcut', {
      tabKey: 'browser:1',
      key: 'w',
    });
  });

  it('leaves everything else to the page', () => {
    const { guest, send } = registered();
    const cases = [
      chord('c'), // not one of ours
      chord('w', { type: 'keyUp' }), // would double-fire
      chord('w', { shift: true }), // Cmd+Shift+W is a different chord
      chord('w', { alt: true }),
      chord('w', { meta: false }), // plain w is typing
    ];
    for (const input of cases) {
      const event = { preventDefault: vi.fn() };
      guest.emit('before-input-event', event, input);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('stops firing once the tab is unregistered', () => {
    const { guest, send } = registered();
    browser.unregister('browser:1');
    guest.emit('before-input-event', { preventDefault: vi.fn() }, chord('w'));
    expect(send).not.toHaveBeenCalled();
  });

  it('does not stack listeners when a guest re-registers', () => {
    const guest = fakeGuest();
    const { send } = registered('browser:1', 1, guest);
    // Same tab, new webContentsId — what reparenting the <webview> produces.
    registry.set(2, guest);
    browser.register('browser:1', 2);

    guest.emit('before-input-event', { preventDefault: vi.fn() }, chord('w'));
    expect(send).toHaveBeenCalledTimes(1);
  });
});
