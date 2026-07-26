import { useCallback, useEffect, useRef, useState } from 'react';
import { Globe, TerminalSquare, X } from 'lucide-react';
import * as webviewCache from '../../lib/browser/webviewCache';
import { Tooltip } from '../ui';
import BrowserToolbar from './BrowserToolbar';
import BrowserErrorOverlay from './BrowserErrorOverlay';

// One browser tab's chrome + viewport. The <webview> itself is not rendered by
// React: webviewCache owns it and re-parents it into `containerRef` on mount,
// parking it off-screen on unmount so the page survives a tab switch. That's
// why this component can be unmounted freely whenever another editor tab is
// active — see src/lib/browser/webviewCache.js.
export default function BrowserPane({
  tabKey,
  initialUrl,
  state,
  onStateChange,
  onClose,
}) {
  const containerRef = useRef(null);
  const [nav, setNav] = useState({ canGoBack: false, canGoForward: false });

  // The webview outlives this component, so its listeners must not close over a
  // stale render's props. Route them through a ref instead — same reason
  // sessionCache re-points `entry.handlers` on every mount.
  const changeRef = useRef(onStateChange);
  changeRef.current = onStateChange;
  const onState = useCallback((patch) => changeRef.current(tabKey, patch), [tabKey]);

  // Create-or-reclaim the webview from wherever it was parked; park it again on
  // unmount rather than destroying it.
  useEffect(() => {
    webviewCache.getOrCreate(tabKey, initialUrl, { onState });
    webviewCache.attach(tabKey, containerRef.current);
    return () => webviewCache.detach(tabKey);
    // initialUrl is only read on first create.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabKey, onState]);

  // Chromium owns the real session history, so re-read it rather than tracking
  // our own index. Loading transitions are when it can change.
  useEffect(() => {
    setNav(webviewCache.navState(tabKey));
  }, [tabKey, state.url, state.loading]);

  const navigate = useCallback((url) => webviewCache.navigate(tabKey, url), [tabKey]);
  const reload = useCallback(() => webviewCache.reload(tabKey), [tabKey]);
  const goBack = useCallback(() => webviewCache.goBack(tabKey), [tabKey]);
  const goForward = useCallback(() => webviewCache.goForward(tabKey), [tabKey]);

  const isBlank = !state.url || state.url === 'about:blank';

  return (
    <>
      <div className="flex items-center gap-1 h-8 px-2 border-b border-border flex-shrink-0">
        <BrowserToolbar
          url={state.url}
          title={state.title}
          favicon={state.favicon}
          loading={state.loading}
          canGoBack={nav.canGoBack}
          canGoForward={nav.canGoForward}
          onGoBack={goBack}
          onGoForward={goForward}
          onReload={reload}
          onNavigate={navigate}
        />
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <Tooltip label="Open DevTools">
            <button
              className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
              aria-label="Open DevTools"
              onClick={() => window.electronAPI.browserOpenDevTools(tabKey)}
            >
              <TerminalSquare size={14} />
            </button>
          </Tooltip>
          <Tooltip label="Close">
            <button
              className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
              aria-label="Close"
              onClick={() => onClose(tabKey)}
            >
              <X size={14} />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="relative flex-1 min-h-0 flex bg-background">
        <div ref={containerRef} className="flex-1 flex min-w-0" />
        {state.error && !state.loading && (
          <BrowserErrorOverlay error={state.error} onRetry={reload} />
        )}
        {isBlank && !state.loading && !state.error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background pointer-events-none">
            <Globe size={36} className="text-muted-foreground/40" strokeWidth={1.5} />
            <div className="text-center">
              <p className="text-[13px] font-medium text-muted-foreground">Browser</p>
              <p className="mt-1 text-[12px] text-muted-foreground/70">
                Enter a URL above to preview a site.
              </p>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
