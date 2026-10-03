import { sanitizeUrl } from './sanitizeUrl';

// Renderer-side <webview> cache — the same "hide, don't destroy" idea as
// src/lib/terminal/sessionCache.js. Each browser tab's <webview> is created
// once and kept alive across React mount/unmount, so switching to a file tab
// and back keeps the page, its scroll position, its JS state and its login
// session rather than reloading from scratch.
//
// The element is inserted into the document exactly once, into a fixed layer
// at the end of <body>, and never moved: re-parenting a <webview> — moving it
// to another parent in the DOM — tears its guest down and loads the page
// again (verified on Electron 28 and 43), which is what this cache exists to
// avoid. Instead the pane gives us a placeholder element, and the webview is
// positioned over it with CSS; leaving a tab only hides it.
//
// The main process (electron/services/browser.cjs) never owns the element; it
// only holds the guest's webContentsId, registered on dom-ready.

const cache = new Map(); // tabKey -> entry

// Partition is shared by every browser tab, so a WordPress login in one tab is
// visible in the next — which is the whole point when the agent and the user
// are looking at the same site. Must match PARTITION in
// electron/services/browser.cjs, which is what "clear browsing data" wipes.
export const PARTITION = 'persist:wpxen-browser';

// Holds every webview. z-index 0 at the end of <body>: above the page content
// it sits over, below every menu, popover, tooltip and dialog (all z-50 and
// up). Pointer events pass through the layer itself; each visible webview
// takes them back.
let layer = null;
function getLayer() {
  if (!layer) {
    layer = document.createElement('div');
    Object.assign(layer.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '0',
      overflow: 'hidden',
      pointerEvents: 'none',
    });
    document.body.appendChild(layer);
  }
  return layer;
}

// While a panel divider is being dragged, every webview lets the pointer
// through (see setDragPassthrough).
let dragPassthrough = false;

// Show `entry` only while it has a live, sized placeholder and nothing in the
// pane (error / blank overlay) is covering it.
function applyVisibility(entry) {
  const shown = !!entry.placeholder && !entry.covered && entry.hasArea;
  entry.webview.style.visibility = shown ? 'visible' : 'hidden';
  entry.webview.style.pointerEvents = shown && !dragPassthrough ? 'auto' : 'none';
}

// Keeps each attached webview on top of its placeholder. One rAF loop for all
// of them, running only while something is attached: layout can move a pane
// without resizing it (a sidebar collapsing), so a ResizeObserver alone
// wouldn't see every change.
let frame = null;
function track() {
  frame = null;
  let attached = 0;
  for (const entry of cache.values()) {
    if (!entry.placeholder) continue;
    attached++;
    const el = entry.placeholder;
    const r = el.isConnected ? el.getBoundingClientRect() : null;
    const hasArea = !!r && r.width > 0 && r.height > 0;
    if (
      r &&
      (r.left !== entry.rect?.left ||
        r.top !== entry.rect?.top ||
        r.width !== entry.rect?.width ||
        r.height !== entry.rect?.height)
    ) {
      entry.rect = { left: r.left, top: r.top, width: r.width, height: r.height };
      Object.assign(entry.webview.style, {
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
    }
    if (hasArea !== entry.hasArea) {
      entry.hasArea = hasArea;
      applyVisibility(entry);
    }
  }
  if (attached > 0) frame = requestAnimationFrame(track);
}

function startTracking() {
  if (frame === null) frame = requestAnimationFrame(track);
}

// handlers = { onState, onNewTab } — replaced on every mount so the cached
// webview's listeners always call the current React component's callbacks.
export function getOrCreate(tabKey, initialUrl, handlers) {
  let entry = cache.get(tabKey);
  if (entry) {
    entry.handlers = handlers;
    return entry;
  }
  entry = createEntry(tabKey, initialUrl, handlers);
  cache.set(tabKey, entry);
  return entry;
}

function createEntry(tabKey, initialUrl, handlers) {
  const api = window.electronAPI;
  // `src` is deliberately NOT set here. A <webview> only spins up its guest
  // once the element is in the document, and setting src beforehand leaves it
  // in a state where dom-ready never fires. attach() sets it on first mount.
  const entry = {
    tabKey,
    handlers,
    registeredId: null,
    favicon: null,
    pendingUrl: sanitizeUrl(initialUrl),
    started: false,
  };

  const webview = document.createElement('webview');
  webview.setAttribute('partition', PARTITION);
  // Popups are denied in the main process and re-emitted as new tabs; the
  // attribute is still needed for setWindowOpenHandler to see them at all.
  webview.setAttribute('allowpopups', '');
  Object.assign(webview.style, {
    position: 'absolute',
    left: '0px',
    top: '0px',
    width: '1024px',
    height: '768px',
    display: 'flex',
    border: 'none',
    visibility: 'hidden',
    pointerEvents: 'none',
  });
  entry.webview = webview;
  entry.placeholder = null;
  entry.covered = false;
  entry.hasArea = false;
  entry.rect = null;
  // Into the document once, for good — never moved again (see top of file).
  getLayer().appendChild(webview);

  const state = (patch) => entry.handlers.onState?.(patch);

  // Register the guest with the main process. dom-ready fires again on every
  // navigation; only a different webContentsId needs re-registering.
  const onDomReady = () => {
    const id = webview.getWebContentsId();
    if (entry.registeredId === id) return;
    entry.registeredId = id;
    api.browserRegister(tabKey, id);
  };

  const onStartLoading = () => {
    entry.favicon = null;
    state({ loading: true, error: null });
  };

  const onStopLoading = () => {
    const url = webview.getURL() || '';
    const title = webview.getTitle() || '';
    state({ loading: false, url, title });
    // The favicon usually arrives after this, so record without one and let
    // onFavicon refresh the entry rather than blocking on it.
    api.browserHistoryRecord({ url, title, faviconUrl: entry.favicon });
  };

  const onNavigate = (e) => {
    state({
      url: e.url || '',
      title: webview.getTitle() || '',
      loading: false,
      error: null,
    });
  };

  const onNavigateInPage = (e) => {
    // Only the top frame changes the address bar; an iframe's hash change
    // (phpMyAdmin uses several) must not rewrite it.
    if (!e.isMainFrame) return;
    state({ url: e.url || '', title: webview.getTitle() || '' });
  };

  const onTitle = (e) => state({ title: e.title || '' });

  const onFavicon = (e) => {
    const favicon = e.favicons?.[0] || null;
    entry.favicon = favicon;
    state({ favicon });
    if (favicon) {
      api.browserHistoryRecord({
        url: webview.getURL() || '',
        title: webview.getTitle() || '',
        faviconUrl: favicon,
      });
    }
  };

  const onFailLoad = (e) => {
    // -3 is ERR_ABORTED, which every ordinary redirect and cancelled request
    // fires. Subframe failures (a missing analytics script) aren't the page.
    if (e.errorCode === -3 || !e.isMainFrame) return;
    state({
      loading: false,
      error: { code: e.errorCode, description: e.errorDescription, url: e.validatedURL },
    });
  };

  webview.addEventListener('dom-ready', onDomReady);
  webview.addEventListener('did-start-loading', onStartLoading);
  webview.addEventListener('did-stop-loading', onStopLoading);
  webview.addEventListener('did-navigate', onNavigate);
  webview.addEventListener('did-navigate-in-page', onNavigateInPage);
  webview.addEventListener('page-title-updated', onTitle);
  webview.addEventListener('page-favicon-updated', onFavicon);
  webview.addEventListener('did-fail-load', onFailLoad);

  entry.cleanup = () => {
    webview.removeEventListener('dom-ready', onDomReady);
    webview.removeEventListener('did-start-loading', onStartLoading);
    webview.removeEventListener('did-stop-loading', onStopLoading);
    webview.removeEventListener('did-navigate', onNavigate);
    webview.removeEventListener('did-navigate-in-page', onNavigateInPage);
    webview.removeEventListener('page-title-updated', onTitle);
    webview.removeEventListener('page-favicon-updated', onFavicon);
    webview.removeEventListener('did-fail-load', onFailLoad);
  };

  return entry;
}

// A <webview> is its own compositor layer and swallows pointer events before
// they reach anything underneath — including the PanelGroup divider, which
// would otherwise stick the moment the pointer crossed onto a loaded page.
// Called from ResizeHandle's onDragging.
export function setDragPassthrough(passthrough) {
  dragPassthrough = passthrough;
  for (const entry of cache.values()) applyVisibility(entry);
}

// Show the cached webview over `placeholder` (the pane's viewport element),
// starting its first load if it hasn't run yet. The webview is already in the
// document, so `src` can be assigned now.
export function attach(tabKey, placeholder) {
  const entry = cache.get(tabKey);
  if (!entry || !placeholder) return;
  entry.placeholder = placeholder;
  entry.rect = null; // force a reposition on the next frame
  entry.hasArea = false;
  applyVisibility(entry);
  startTracking();
  if (!entry.started) {
    entry.started = true;
    entry.webview.src = entry.pendingUrl;
  }
}

// Hide on tab switch — the guest and its page stay alive, in place.
export function detach(tabKey) {
  const entry = cache.get(tabKey);
  if (!entry) return;
  entry.placeholder = null;
  applyVisibility(entry);
}

// The pane draws its own overlay (load error, blank tab) over the page area;
// the webview sits on a layer above the pane, so it steps aside meanwhile.
export function setCovered(tabKey, covered) {
  const entry = cache.get(tabKey);
  if (!entry || entry.covered === !!covered) return;
  entry.covered = !!covered;
  applyVisibility(entry);
}

export function navigate(tabKey, url) {
  const entry = cache.get(tabKey);
  if (!entry) return;
  const target = sanitizeUrl(url);
  // Before the first attach there is no guest to talk to — redirect the
  // pending first load instead of throwing it away.
  if (!entry.started) {
    entry.pendingUrl = target;
    return;
  }
  try {
    entry.webview.loadURL(target);
  } catch {
    // Guest still coming up; it will land on pendingUrl.
  }
}

export function reload(tabKey) {
  try {
    cache.get(tabKey)?.webview.reload();
  } catch {
    // Guest not ready.
  }
}

export function goBack(tabKey) {
  const webview = cache.get(tabKey)?.webview;
  try {
    if (webview?.canGoBack()) webview.goBack();
  } catch {
    // Guest not ready.
  }
}

export function goForward(tabKey) {
  const webview = cache.get(tabKey)?.webview;
  try {
    if (webview?.canGoForward()) webview.goForward();
  } catch {
    // Guest not ready.
  }
}

// Chromium owns the real session history; the store only mirrors it for the
// toolbar, so ask the guest rather than tracking our own index.
export function navState(tabKey) {
  const webview = cache.get(tabKey)?.webview;
  try {
    return {
      canGoBack: !!webview?.canGoBack(),
      canGoForward: !!webview?.canGoForward(),
    };
  } catch {
    return { canGoBack: false, canGoForward: false };
  }
}

// Fully tear down — only when the tab is closed for good.
export function dispose(tabKey) {
  const entry = cache.get(tabKey);
  if (!entry) return;
  entry.cleanup();
  entry.webview.remove();
  cache.delete(tabKey);
  window.electronAPI.browserUnregister(tabKey);
}

// Tear down every tab whose key starts with `prefix` — each owner (the
// Agents pane, the Floating Workspace) disposes only its own pages.
export function disposeAll(prefix = '') {
  for (const tabKey of [...cache.keys()]) {
    if (tabKey.startsWith(prefix)) dispose(tabKey);
  }
}
