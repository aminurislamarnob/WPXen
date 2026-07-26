import { describe, it, expect, vi, beforeEach } from 'vitest';
import browser from '../electron/services/browser.cjs';

// The module reaches its guests through electron's `webContents` registry.
// These .cjs services load via Node's CJS loader, so vi.mock on `electron`
// never reaches them — swap the registry through the module's own seam instead
// (same approach as external-tools.test.js).
function fakeGuest(over = {}) {
  return {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    setBackgroundThrottling: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    loadURL: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    openDevTools: vi.fn(),
    ...over,
  };
}

let registry;
const fromId = vi.fn((id) => registry.get(id) ?? null);

beforeEach(() => {
  registry = new Map();
  fromId.mockClear();
  browser.__setDeps({ webContents: { fromId } });
  browser.unregisterAll();
  browser.setWindow(null);
});

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
