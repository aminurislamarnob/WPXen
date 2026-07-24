import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ArrowDown } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { MONO_STACK, onThemeChange, terminalThemes, themeName } from '../lib/theme';
import {
  isSelectAllChord,
  translateLineEditChord,
  shouldBubbleChord,
  trimSelection,
  isNonTextPaste,
} from '../lib/terminal/keys';
import { Utf8Base64 } from '../lib/terminal/utf8Base64';
import { attachWebgl } from '../lib/terminal/webgl';
import TerminalSearchBar from './TerminalSearchBar';

// Cmd held, nothing else — for the terminal-local Cmd+F/K shortcuts.
const metaOnly = (e) => e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;

// Embedded terminal pane bound to a single main-process Session (by sessionId).
// Replays the ring buffer on attach, then streams live. Fills its parent, which
// sets the height.
export default function Terminal({ sessionId, onExited, onRestart }) {
  const hostRef = useRef(null);
  const searchAddonRef = useRef(null);
  const termRef = useRef(null);
  const [exit, setExit] = useState(null); // { code } once the Session ends
  const [searchOpen, setSearchOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const host = hostRef.current;
    const api = window.electronAPI;
    const term = new XTerm({
      fontFamily: MONO_STACK,
      fontSize: 13,
      cursorBlink: true,
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
      allowProposedApi: true,
      scrollback: 5000,
      // Keep Option+key typing intl characters (e.g. Option+2 = @) instead of
      // sending a Meta-escaped sequence.
      macOptionIsMeta: false,
      theme: terminalThemes[themeName()],
    });
    // The terminal blends into the page, so its palette has to flip with the
    // macOS appearance rather than staying a fixed dark box.
    const stopThemeWatch = onThemeChange((name) => {
      term.options.theme = terminalThemes[name];
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    // OSC 52 clipboard (tmux/vim/agents write the system clipboard). The
    // UTF-8-safe codec fixes multi-byte mojibake in the addon's default.
    term.loadAddon(new ClipboardAddon(new Utf8Base64()));
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    searchAddonRef.current = searchAddon;
    // Correct emoji/CJK cell widths — agents emit both constantly.
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    // Cmd+click a URL in output → open in the default browser (plain click must
    // not hijack the TUI).
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (!event.metaKey) return;
        api.openSiteInBrowser(uri);
      })
    );
    term.open(host);
    fit.fit();
    const detachWebgl = attachWebgl(term);

    // Custom key handler — short-circuits xterm's key encoder so line-edit
    // chords reach the shell, Cmd+A selects all, and every Cmd chord bubbles
    // to the OS clipboard pipeline instead of leaking CSI-u into TUIs.
    term.attachCustomKeyEventHandler((e) => {
      const seq = translateLineEditChord(e);
      if (seq !== null) {
        if (e.type === 'keydown') {
          e.preventDefault();
          term.input(seq, true);
        }
        return false;
      }
      if (isSelectAllChord(e)) {
        if (e.type === 'keydown') {
          e.preventDefault();
          term.selectAll();
        }
        return false;
      }
      // Cmd+F — toggle the find bar.
      if (e.code === 'KeyF' && metaOnly(e)) {
        if (e.type === 'keydown') {
          e.preventDefault();
          setSearchOpen((v) => !v);
        }
        return false;
      }
      // Cmd+K — clear the viewport and the session's ring buffer (so a later
      // reattach doesn't replay the cleared content).
      if (e.code === 'KeyK' && metaOnly(e)) {
        if (e.type === 'keydown') {
          e.preventDefault();
          term.clear();
          api.terminalClear(sessionId);
        }
        return false;
      }
      // Cmd+Shift+↓ — scroll to bottom.
      if (e.code === 'ArrowDown' && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
        if (e.type === 'keydown') {
          e.preventDefault();
          term.scrollToBottom();
        }
        return false;
      }
      // Do NOT preventDefault: the browser keydown → paste pipeline is what
      // fires xterm's paste event; we only skip xterm's own key encoder.
      if (shouldBubbleChord(e)) return false;
      return true;
    });

    const onData = term.onData((data) => api.terminalInput(sessionId, data));

    // Track scroll position to toggle the scroll-to-bottom button.
    const checkAtBottom = () => {
      const b = term.buffer.active;
      setAtBottom(b.viewportY >= b.baseY);
    };
    const writeParsed = term.onWriteParsed(checkAtBottom);
    const scrolled = term.onScroll(checkAtBottom);

    // Copy trims trailing whitespace (terminals pad lines to grid width).
    const onCopy = (e) => {
      const sel = term.getSelection();
      if (!sel) return;
      const trimmed = trimSelection(sel);
      if (e.clipboardData) {
        e.preventDefault();
        e.clipboardData.setData('text/plain', trimmed);
      } else {
        navigator.clipboard?.writeText(trimmed).catch(() => {});
      }
    };
    term.element?.addEventListener('copy', onCopy);

    // Image/file paste → forward literal ^V so agents attach the image, rather
    // than xterm emitting empty bracketed-paste markers. Capture phase on the
    // wrapper preempts xterm's own paste listeners.
    const onPaste = (e) => {
      if (!isNonTextPaste(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      term.input('\x16', true);
    };
    host.addEventListener('paste', onPaste, { capture: true });

    api.on('terminal-replay', (msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.data) term.write(msg.data);
      if (msg.exited) setExit({ code: null });
      fit.fit();
      api.terminalResize(sessionId, term.cols, term.rows);
    });
    api.on('terminal-data', (msg) => {
      if (msg.sessionId === sessionId) term.write(msg.data);
    });
    api.on('terminal-exit', (msg) => {
      if (msg.sessionId === sessionId) setExit({ code: msg.code });
    });

    // Attach: main binds this window to the Session and replays the buffer.
    api.terminalReady(sessionId);
    term.focus();

    const onResize = () => {
      fit.fit();
      api.terminalResize(sessionId, term.cols, term.rows);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(host);

    return () => {
      onData.dispose();
      writeParsed.dispose();
      scrolled.dispose();
      stopThemeWatch();
      detachWebgl();
      ro.disconnect();
      term.element?.removeEventListener('copy', onCopy);
      host?.removeEventListener('paste', onPaste, { capture: true });
      api.off('terminal-replay');
      api.off('terminal-data');
      api.off('terminal-exit');
      searchAddonRef.current = null;
      termRef.current = null;
      term.dispose();
    };
  }, [sessionId]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-background">
      <div ref={hostRef} className="h-full w-full p-2" />
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
        className={`panel absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-opacity hover:text-foreground ${
          atBottom ? 'pointer-events-none opacity-0' : 'opacity-100'
        }`}
      >
        <ArrowDown size={14} />
      </button>
      {exit && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
          <div className="panel p-6 w-[320px] text-center">
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
