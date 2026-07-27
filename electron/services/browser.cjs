'use strict';

// Main-process owner of the in-app browser's <webview> guests.
//
// The renderer owns the <webview> element itself (src/lib/browser/webviewCache.js)
// and hands us the guest's webContentsId once it reaches dom-ready. Everything a
// renderer cannot reach — window-open policy, DevTools, native menus, key
// interception — is attached here, keyed by the browser tab's key.
//
// register() is deliberately idempotent: reparenting a <webview> across the DOM
// mints a fresh webContentsId, so the renderer re-registers on every dom-ready
// and we must tear the previous guest's listeners down rather than stack a
// second set on top.

const { openExternalSafely } = require('./safeUrl.cjs');

// electron is resolved on access rather than at module scope. CI installs with
// ELECTRON_SKIP_BINARY_DOWNLOAD=1, where `require('electron')` throws instead of
// handing back the API surface — at module scope that takes down the whole test
// file at import time, before a single pure helper can run. Undefined is a fine
// answer there; `guest()` already treats a missing registry as "no guest", and
// off the runner these getters only ever fire inside a real main process.
function fromElectron(name) {
  try {
    return require('electron')[name];
  } catch {
    return undefined;
  }
}

// Swapped in tests — these .cjs services load through Node's CJS loader, so
// vi.mock never reaches them (same seam as externalTools.cjs). An override wins
// over the real module even when it is explicitly set to undefined.
let overrides = {};

const deps = {
  get webContents() {
    return 'webContents' in overrides
      ? overrides.webContents
      : fromElectron('webContents');
  },
  get Menu() {
    return 'Menu' in overrides ? overrides.Menu : fromElectron('Menu');
  },
  get clipboard() {
    return 'clipboard' in overrides ? overrides.clipboard : fromElectron('clipboard');
  },
  get openExternalSafely() {
    return 'openExternalSafely' in overrides
      ? overrides.openExternalSafely
      : openExternalSafely;
  },
};

function __setDeps(next) {
  overrides = { ...overrides, ...next };
}

// The only schemes a browser tab may ever sit on. Everything else — file://,
// a custom protocol handler, javascript: — is refused, whether it arrives as a
// <webview> src or as a navigation the page itself triggered.
function isAllowedBrowserUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' || protocol === 'about:';
  } catch {
    return false;
  }
}

// What a user types in the address bar isn't a URL yet. Mirrors the renderer's
// copy in src/lib/browser/sanitizeUrl.js — keep the two in sync.
function sanitizeUrl(url) {
  const value = String(url ?? '').trim();
  if (!value) return 'about:blank';
  if (/^https?:\/\//i.test(value) || value.startsWith('about:')) return value;
  if (/^(localhost|127\.0\.0\.1)(:|\/|$)/.test(value)) return `http://${value}`;
  // A dot means they meant a host; no dot means they meant a search.
  if (value.includes('.') && !value.includes(' ')) return `https://${value}`;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

// Every browser tab shares one session, so signing into a site in one tab is
// visible in the next. Must match PARTITION in src/lib/browser/webviewCache.js,
// which is what actually sets it on the element (asserted in the tests).
const PARTITION = 'persist:wpdevpilot-browser';

// tabKey -> webContentsId of the live guest
const guests = new Map();
// tabKey -> [teardown, …] for every listener/handler we attached to that guest
const teardowns = new Map();

let win = null;

// The renderer subscribes per-channel and filters on tabKey (there is one
// window, and many browser tabs share a channel — same shape as terminal-data).
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function setWindow(nextWin) {
  win = nextWin;
}

function runTeardowns(tabKey) {
  for (const teardown of teardowns.get(tabKey) || []) {
    try {
      teardown();
    } catch {
      // The guest may already be destroyed; its listeners went with it.
    }
  }
  teardowns.delete(tabKey);
}

function getWebContents(tabKey) {
  const id = guests.get(tabKey);
  if (id == null || !deps.webContents) return null;
  const wc = deps.webContents.fromId(id);
  if (!wc || wc.isDestroyed()) return null;
  return wc;
}

function register(tabKey, webContentsId) {
  // Always clean first, even when the id is unchanged, so callers can
  // re-register freely without doubling listeners.
  runTeardowns(tabKey);
  guests.set(tabKey, webContentsId);

  const wc = getWebContents(tabKey);
  if (!wc) return;

  // Parked (off-screen) tabs must not keep running timers at full speed.
  wc.setBackgroundThrottling(true);

  // target="_blank" and window.open() would otherwise mint a real BrowserWindow
  // with no chrome and no way to close it. Deny, and let the renderer open the
  // URL as another browser tab instead.
  wc.setWindowOpenHandler(({ url }) => {
    if (url && url !== 'about:blank') send('browser-new-window', { tabKey, url });
    return { action: 'deny' };
  });

  teardowns.set(tabKey, []);
  attachSchemeGuard(tabKey, wc);
  attachContextMenu(tabKey, wc);
  attachKeyInterception(tabKey, wc);
}

// Refuse a navigation to anything that isn't a web page. This is the real
// enforcement point for the scheme allowlist — will-attach-webview only ever
// sees the initial src, which is empty by the time it runs.
function attachSchemeGuard(tabKey, wc) {
  const guard = (event, url) => {
    if (!isAllowedBrowserUrl(url)) event.preventDefault();
  };
  on(tabKey, wc, 'will-navigate', guard);
  on(tabKey, wc, 'will-redirect', guard);
}

function on(tabKey, wc, event, handler) {
  wc.on(event, handler);
  teardowns.get(tabKey)?.push(() => wc.off(event, handler));
}

// A guest renders its own page, so the renderer's React context menus can't
// reach it — the native one has to be built here.
function attachContextMenu(tabKey, wc) {
  on(tabKey, wc, 'context-menu', (_event, params) => {
    const { linkURL, pageURL, selectionText, editFlags } = params;
    const items = [];

    if (linkURL) {
      items.push(
        {
          label: 'Open Link in Default Browser',
          click: () => deps.openExternalSafely(linkURL),
        },
        {
          label: 'Open Link in New Tab',
          click: () => send('browser-new-window', { tabKey, url: linkURL }),
        },
        { label: 'Copy Link Address', click: () => deps.clipboard.writeText(linkURL) },
        { type: 'separator' }
      );
    }

    if (selectionText) {
      items.push({ label: 'Copy', enabled: editFlags.canCopy, click: () => wc.copy() });
    }
    if (editFlags.canPaste) items.push({ label: 'Paste', click: () => wc.paste() });
    if (editFlags.canSelectAll) {
      items.push({ label: 'Select All', click: () => wc.selectAll() });
    }
    if (selectionText || editFlags.canPaste || editFlags.canSelectAll) {
      items.push({ type: 'separator' });
    }

    items.push(
      { label: 'Back', enabled: wc.canGoBack(), click: () => wc.goBack() },
      { label: 'Forward', enabled: wc.canGoForward(), click: () => wc.goForward() },
      { label: 'Reload', click: () => wc.reload() }
    );

    const hasPage = !!pageURL && pageURL !== 'about:blank';
    if (!linkURL) {
      items.push(
        { type: 'separator' },
        {
          label: 'Open Page in Default Browser',
          enabled: hasPage,
          click: () => deps.openExternalSafely(pageURL),
        },
        {
          label: 'Copy Page URL',
          enabled: hasPage,
          click: () => deps.clipboard.writeText(pageURL),
        },
        { type: 'separator' },
        { label: 'Inspect Element', click: () => wc.inspectElement(params.x, params.y) }
      );
    }

    deps.Menu.buildFromTemplate(items).popup();
  });
}

// While a guest has focus its renderer sees keystrokes first, so neither the
// app's window-level listeners nor the menu accelerators fire — Cmd+W would
// hide the whole app and Cmd+R reload WPDevPilot itself. before-input-event runs
// in the main process ahead of both, and preventDefault suppresses them.
//
// keyDown-only so the chord doesn't fire again on keyUp; Shift/Alt are left
// alone so their variants still reach the page.
function attachKeyInterception(tabKey, wc) {
  on(tabKey, wc, 'before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.shift || input.alt) return;
    if (!(input.meta || input.control)) return;

    const key = String(input.key || '').toLowerCase();
    // w/r act on the browser tab; the rest are app shortcuts (Layout.jsx) the
    // user would otherwise lose the moment a page took focus.
    if (!['w', 'r', 'b', '[', ']'].includes(key)) return;
    event.preventDefault();
    send('browser-shortcut', { tabKey, key });
  });
}

function unregister(tabKey) {
  runTeardowns(tabKey);
  guests.delete(tabKey);
}

function unregisterAll() {
  for (const tabKey of [...guests.keys()]) unregister(tabKey);
}

function navigate(tabKey, url) {
  const wc = getWebContents(tabKey);
  if (!wc) return false;
  wc.loadURL(sanitizeUrl(url));
  return true;
}

function reload(tabKey, hard = false) {
  const wc = getWebContents(tabKey);
  if (!wc) return false;
  if (hard) wc.reloadIgnoringCache();
  else wc.reload();
  return true;
}

function openDevTools(tabKey) {
  const wc = getWebContents(tabKey);
  if (!wc) return false;
  // Detached: the guest fills its pane, so docked devtools would squeeze the
  // page into nothing.
  wc.openDevTools({ mode: 'detach' });
  return true;
}

module.exports = {
  PARTITION,
  sanitizeUrl,
  isAllowedBrowserUrl,
  setWindow,
  register,
  unregister,
  unregisterAll,
  getWebContents,
  navigate,
  reload,
  openDevTools,
  __setDeps,
};
