import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, X } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { formatDropInput } from '../lib/terminal/keys';
import * as sessionCache from '../lib/terminal/sessionCache';
import TerminalSearchBar from './TerminalSearchBar';
import LinkActionCard from './LinkActionCard';
import { useSettings } from '../lib/useSettings';
import { resolveLinkClick } from '../lib/terminal/linkActions';

// Embedded view over a cached main-process Session (by sessionId). The xterm
// instance lives in sessionCache and is re-parented here on mount, so switching
// tabs never disposes it — this component is just the glue: it mounts the
// cached wrapper, tracks scroll for the scroll-to-bottom button, owns the
// find-bar UI state, and renders the session-ended overlay.
export default function Terminal({
  sessionId,
  onExited,
  onRestart,
  rootPath,
  onOpenFile,
  onOpenLink,
  onTitle,
  onClosePane,
  onFocus,
  onBlur,
}) {
  // Link clicks: plain → the action card, ⌘ / ⇧⌘ → straight to a destination.
  // `onOpenLink(url, destination)` — 'system' or 'app' — is the owner's.
  const { settings } = useSettings();
  const openLinksIn = settings['app.openLinksIn'];
  const [linkRequest, setLinkRequest] = useState(null); // { url, x, y }
  const onLinkClick = useCallback(
    (event, url) => {
      const action = resolveLinkClick(event, openLinksIn);
      if (action === 'actions') {
        setLinkRequest({ url, x: event.clientX, y: event.clientY });
      } else if (action) {
        if (onOpenLink) onOpenLink(url, action);
        else window.electronAPI.openSiteInBrowser(url);
      }
    },
    [openLinksIn, onOpenLink]
  );

  const hostRef = useRef(null);
  const searchAddonRef = useRef(null);
  const termRef = useRef(null);
  const [exit, setExit] = useState(null); // { code } once the Session ends
  const [searchOpen, setSearchOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const host = hostRef.current;
    setExit(sessionCache.isExited(sessionId) ? { code: null } : null);
    setSearchOpen(false);

    const entry = sessionCache.getOrCreate(sessionId, {
      rootPath,
      onOpenFile,
      onOpenLink,
      onLinkClick,
      onTitle: (title) => onTitle?.(sessionId, title),
      onToggleSearch: () => setSearchOpen((v) => !v),
      onExit: (code) => setExit({ code }),
    });
    termRef.current = entry.term;
    searchAddonRef.current = entry.searchAddon;

    sessionCache.attach(sessionId, host);

    // Track scroll position to toggle the scroll-to-bottom button. These xterm
    // listeners are cheap and per-mount (disposed on unmount).
    const checkAtBottom = () => {
      const b = entry.term.buffer.active;
      setAtBottom(b.viewportY >= b.baseY);
    };
    checkAtBottom();
    const writeParsed = entry.term.onWriteParsed(checkAtBottom);
    const scrolled = entry.term.onScroll(checkAtBottom);

    const ro = new ResizeObserver(() => sessionCache.fit(sessionId));
    ro.observe(host);

    return () => {
      writeParsed.dispose();
      scrolled.dispose();
      ro.disconnect();
      sessionCache.detach(sessionId);
      searchAddonRef.current = null;
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Keep the cached handlers pointed at the latest callbacks/props without
  // remounting the terminal.
  useEffect(() => {
    const entry = sessionCache.getOrCreate(sessionId, {
      rootPath,
      onOpenFile,
      onOpenLink,
      onLinkClick,
      onTitle: (title) => onTitle?.(sessionId, title),
      onToggleSearch: () => setSearchOpen((v) => !v),
      onExit: (code) => setExit({ code }),
    });
    // getOrCreate already replaced entry.handlers; nothing else to do.
    void entry;
  }, [sessionId, rootPath, onOpenFile, onOpenLink, onLinkClick, onTitle]);

  const onDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const onDrop = (e) => {
    e.preventDefault();
    // Finder drops carry native files, resolved to paths through preload;
    // internal Files-tree drags carry the path in text/plain.
    const files = [...e.dataTransfer.files];
    let paths;
    if (files.length > 0) {
      paths = files.map((f) => window.electronAPI.pathForFile(f)).filter(Boolean);
    } else {
      const plain = e.dataTransfer.getData('text/plain');
      if (!plain) return;
      paths = [plain];
    }
    if (paths.length === 0) return;
    if (!sessionCache.isExited(sessionId)) {
      window.electronAPI.terminalInput(
        sessionId,
        formatDropInput(paths, {
          bracketedPaste: sessionCache.isBracketedPaste(sessionId),
        })
      );
    }
  };

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-background"
      onDragOver={onDragOver}
      onDrop={onDrop}
      onFocusCapture={onFocus}
      onBlurCapture={onBlur}
    >
      <div ref={hostRef} className="h-full w-full p-2" />
      {onClosePane && (
        <button
          onClick={onClosePane}
          className="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Close pane"
          title="Close pane"
        >
          <X size={14} />
        </button>
      )}
      {linkRequest && (
        <LinkActionCard
          request={linkRequest}
          openLinksIn={openLinksIn}
          onOpen={(url, destination) =>
            onOpenLink
              ? onOpenLink(url, destination)
              : window.electronAPI.openSiteInBrowser(url)
          }
          onClose={() => {
            setLinkRequest(null);
            termRef.current?.focus();
          }}
        />
      )}
      {searchOpen && (
        <TerminalSearchBar
          searchAddon={searchAddonRef.current}
          onClose={() => {
            setSearchOpen(false);
            searchAddonRef.current?.clearDecorations();
            termRef.current?.focus();
          }}
        />
      )}
      <button
        onClick={() => termRef.current?.scrollToBottom()}
        aria-label="Scroll to bottom"
        className={`panel absolute bottom-3 left-1/2 z-10 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full text-muted-foreground transition-opacity hover:text-foreground ${
          atBottom ? 'pointer-events-none opacity-0' : 'opacity-100'
        }`}
      >
        <ArrowDown size={14} />
      </button>
      {exit && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
          <div className="panel w-[320px] p-6 text-center">
            <p className="text-sm font-medium text-foreground">Session ended</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {exit.code == null
                ? 'The shell is no longer running.'
                : `The shell exited (code ${exit.code}).`}
            </p>
            <div className="mt-4 flex justify-center gap-2">
              {onRestart && (
                <button className="btn btn-primary" onClick={onRestart}>
                  Restart
                </button>
              )}
              <button className="btn btn-secondary" onClick={onExited}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
