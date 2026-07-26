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

const electron = require('electron');

// Swapped in tests — these .cjs services load through Node's CJS loader, where
// `require('electron')` yields the binary path rather than the API surface, so
// vi.mock never reaches them (same seam as externalTools.cjs).
let deps = {
  webContents: electron.webContents,
};

function __setDeps(next) {
  deps = { ...deps, ...next };
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
  sanitizeUrl,
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
