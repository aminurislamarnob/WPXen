import { sanitizeUrl } from './sanitizeUrl';

// Renderer-side <webview> cache — the same "hide, don't destroy" pattern as
// src/lib/terminal/sessionCache.js. Each browser tab's <webview> is created
// once and re-parented across React mount/unmount instead of being torn down,
// so switching to a file tab and back keeps the page, its scroll position, its
// JS state and its login session rather than reloading from scratch.
//
// The main process (electron/services/browser.cjs) never owns the element; it
// only holds the guest's webContentsId, which the renderer re-registers on
// every dom-ready because reparenting mints a new one.

const cache = new Map(); // tabKey -> entry

// Partition is shared by every browser tab, so a WordPress login in one tab is
// visible in the next — which is the whole point when the agent and the user
// are looking at the same site. Must match PARTITION in
// electron/services/browser.cjs, which is what "clear browsing data" wipes.
export const PARTITION = 'persist:wpdevpilot-browser';

let hiddenContainer = null;

// Parked webviews live here: off-screen but still in the document, because
// detaching from the DOM entirely destroys the guest.
function getHiddenContainer() {
  if (!hiddenContainer) {
    hiddenContainer = document.createElement('div');
    Object.assign(hiddenContainer.style, {
      position: 'fixed',
      left: '-10000px',
      top: '-10000px',
      width: '1024px',
      height: '768px',
      overflow: 'hidden',
      pointerEvents: 'none',
    });
    document.body.appendChild(hiddenContainer);
  }
  return hiddenContainer;
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
    display: 'flex',
    flex: '1',
    width: '100%',
    height: '100%',
    border: 'none',
  });
  entry.webview = webview;

  const state = (patch) => entry.handlers.onState?.(patch);

  // The guest's webContentsId changes when the element is reparented, so
  // re-register whenever it differs from what the main process last saw.
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
  for (const entry of cache.values()) {
    entry.webview.style.pointerEvents = passthrough ? 'none' : '';
  }
}

// Move the cached webview into a live container, starting its first load if it
// hasn't run yet. The element has to be in the document before `src` is
// assigned, so this is the earliest the load can begin.
export function attach(tabKey, container) {
  const entry = cache.get(tabKey);
  if (!entry || !container) return;
  container.appendChild(entry.webview);
  if (!entry.started) {
    entry.started = true;
    entry.webview.src = entry.pendingUrl;
  }
}

// Park on tab switch — the guest and its page stay alive in the cache.
export function detach(tabKey) {
  const entry = cache.get(tabKey);
  if (entry) getHiddenContainer().appendChild(entry.webview);
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

export function disposeAll() {
  for (const tabKey of [...cache.keys()]) dispose(tabKey);
}
