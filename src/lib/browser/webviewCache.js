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
// are looking at the same site.
const PARTITION = 'persist:wpherd-browser';

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
  const entry = { tabKey, handlers, registeredId: null, favicon: null };

  const webview = document.createElement('webview');
  webview.setAttribute('partition', PARTITION);
  // Popups are denied in the main process and re-emitted as new tabs; the
  // attribute is still needed for setWindowOpenHandler to see them at all.
  webview.setAttribute('allowpopups', '');
  webview.setAttribute('src', sanitizeUrl(initialUrl));
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
    state({
      loading: false,
      url: webview.getURL() || '',
      title: webview.getTitle() || '',
    });
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

  // Park it immediately: React mounts the pane and calls attach() right after,
  // but the element has to be in the document to start loading either way.
  getHiddenContainer().appendChild(webview);
  return entry;
}

// Move the cached webview into a live container.
export function attach(tabKey, container) {
  const entry = cache.get(tabKey);
  if (!entry || !container) return;
  container.appendChild(entry.webview);
}

// Park on tab switch — the guest and its page stay alive in the cache.
export function detach(tabKey) {
  const entry = cache.get(tabKey);
  if (entry) getHiddenContainer().appendChild(entry.webview);
}

export function navigate(tabKey, url) {
  const entry = cache.get(tabKey);
  if (!entry) return;
  try {
    entry.webview.loadURL(sanitizeUrl(url));
  } catch {
    // Not attached yet; the initial src covers the first load.
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
