import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { onThemeChange, terminalThemes, themeName } from '../theme';
import { onTypographyChange, terminalOptions } from '../typography';
import {
  isSelectAllChord,
  translateLineEditChord,
  shouldBubbleChord,
  trimSelection,
  isNonTextPaste,
} from './keys';
import { Utf8Base64 } from './utf8Base64';
import { attachWebgl } from './webgl';
import { registerQuerySuppression } from './querySuppression';
import { createFileLinkProvider } from './fileLinkProvider';

// Renderer-side terminal cache (Superset's "hide attach" pattern). Each xterm
// opens into a detached wrapper div that is re-parented across React
// mount/unmount instead of being disposed — so switching session tabs keeps
// scroll position, selection, and images, and background sessions keep
// buffering their IPC stream while hidden. The main-process pty is unchanged
// (ADR 0001): this is purely a renderer lifecycle optimization.

const cache = new Map(); // sessionId -> entry

const metaOnly = (e) => e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;

// One module-level theme watcher flips every cached terminal with the system
// appearance (there can be many; the mounted one isn't special).
onThemeChange((name) => {
  for (const entry of cache.values()) {
    entry.term.options.theme = terminalThemes[name];
  }
});

// Typography changes apply to every cached terminal too, then refit — font
// metrics change the cell size, so the pty needs the new row/col count.
onTypographyChange(() => {
  const options = terminalOptions();
  for (const entry of cache.values()) {
    Object.assign(entry.term.options, options);
    try {
      entry.fit?.fit();
    } catch {
      // A hidden terminal has no measurable size yet; it refits on mount.
    }
  }
});

// handlers = { rootPath, onOpenFile, onToggleSearch, onTitle, onExit }
// The object is replaced on every mount so cached xterm handlers always call
// the current React component's callbacks via entry.handlers.
export function getOrCreate(sessionId, handlers) {
  let entry = cache.get(sessionId);
  if (entry) {
    // Just re-point the cached xterm handlers at the current callbacks. The
    // mount effect syncs already-exited state via isExited(); calling onExit
    // here would re-fire on every handler update and loop.
    entry.handlers = handlers;
    return entry;
  }
  entry = createEntry(sessionId, handlers);
  cache.set(sessionId, entry);
  return entry;
}

function createEntry(sessionId, handlers) {
  const api = window.electronAPI;
  const entry = { sessionId, handlers, exited: false, exitCode: null };

  const term = new XTerm({
    cursorInactiveStyle: 'outline',
    allowProposedApi: true,
    scrollback: 5000,
    macOptionIsMeta: false,
    theme: terminalThemes[themeName()],
    // Font, size, cursor and contrast come from Settings → Appearance.
    ...terminalOptions(),
  });
  entry.term = term;

  // Detached wrapper — moved between containers via appendChild without
  // disposing the terminal.
  const wrapper = document.createElement('div');
  wrapper.style.width = '100%';
  wrapper.style.height = '100%';
  entry.wrapper = wrapper;

  const fit = new FitAddon();
  term.loadAddon(fit);
  entry.fit = fit;
  term.loadAddon(new ClipboardAddon(new Utf8Base64()));
  const searchAddon = new SearchAddon();
  term.loadAddon(searchAddon);
  entry.searchAddon = searchAddon;
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      if (event.metaKey) api.openSiteInBrowser(uri);
    })
  );

  term.open(wrapper);
  entry.detachWebgl = attachWebgl(term);
  registerQuerySuppression(term);

  // File-path links → open in the editor at line:col (Cmd+click). The provider
  // owns its stat cache, so it is disposed with the terminal (see cleanup).
  const linkProvider = createFileLinkProvider(term, {
    getRootPath: () => entry.handlers.rootPath,
    onOpen: (resolved, line, col, isDir) =>
      entry.handlers.onOpenFile?.(resolved, line, col, isDir),
  });
  const linkRegistration = term.registerLinkProvider(linkProvider);

  // Custom key handler — bubbles Cmd chords, runs line-edit chords, and wires
  // the terminal-local Cmd+F/K/Shift+Down shortcuts.
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
    if (e.code === 'KeyF' && metaOnly(e)) {
      if (e.type === 'keydown') {
        e.preventDefault();
        entry.handlers.onToggleSearch?.();
      }
      return false;
    }
    if (e.code === 'KeyK' && metaOnly(e)) {
      if (e.type === 'keydown') {
        e.preventDefault();
        term.clear();
        api.terminalClear(sessionId);
      }
      return false;
    }
    if (e.code === 'ArrowDown' && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
      if (e.type === 'keydown') {
        e.preventDefault();
        term.scrollToBottom();
      }
      return false;
    }
    if (shouldBubbleChord(e)) return false;
    return true;
  });

  const disposables = [];
  disposables.push(
    term.onData((data) => {
      if (!entry.exited) api.terminalInput(sessionId, data);
    })
  );
  disposables.push(
    term.onTitleChange((title) => {
      if (title) entry.handlers.onTitle?.(title);
    })
  );

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

  // Image/file paste → forward literal ^V so agents attach the image.
  const onPaste = (e) => {
    if (!isNonTextPaste(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    term.input('\x16', true);
  };
  wrapper.addEventListener('paste', onPaste, { capture: true });

  // IPC stream — stays subscribed for the session's whole life so data keeps
  // flowing to xterm while the tab is hidden. `on` returns an unsubscribe.
  const offReplay = api.on('terminal-replay', (msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.data) term.write(msg.data);
    if (msg.exited) markExit(entry, null);
  });
  const offData = api.on('terminal-data', (msg) => {
    if (msg.sessionId === sessionId) term.write(msg.data);
  });
  const offExit = api.on('terminal-exit', (msg) => {
    if (msg.sessionId === sessionId) markExit(entry, msg.code);
  });

  entry.cleanup = () => {
    disposables.forEach((d) => d.dispose());
    offReplay();
    offData();
    offExit();
    entry.detachWebgl();
    linkRegistration.dispose();
    linkProvider.dispose();
    term.element?.removeEventListener('copy', onCopy);
    wrapper.removeEventListener('paste', onPaste, { capture: true });
  };

  // Bind the window to this Session and replay its ring buffer — done exactly
  // once, at creation (later mounts reuse the live xterm).
  api.terminalReady(sessionId);

  return entry;
}

function markExit(entry, code) {
  entry.exited = true;
  entry.exitCode = code;
  entry.handlers.onExit?.(code);
}

// Attach the cached wrapper into a live container and fit to it.
export function attach(sessionId, container) {
  const entry = cache.get(sessionId);
  if (!entry || !container) return;
  container.appendChild(entry.wrapper);
  entry.fit.fit();
  window.electronAPI.terminalResize(sessionId, entry.term.cols, entry.term.rows);
  if (!entry.exited) entry.term.focus();
}

// Detach on tab switch — the xterm and its IPC stream stay alive in the cache.
export function detach(sessionId) {
  const entry = cache.get(sessionId);
  if (entry) entry.wrapper.remove();
}

// Fit + push the new size to the pty (called from the ResizeObserver).
export function fit(sessionId) {
  const entry = cache.get(sessionId);
  if (!entry || !entry.wrapper.isConnected) return;
  entry.fit.fit();
  window.electronAPI.terminalResize(sessionId, entry.term.cols, entry.term.rows);
}

export function isExited(sessionId) {
  return cache.get(sessionId)?.exited ?? false;
}

// Fully tear down — only when the Session is closed for good.
export function dispose(sessionId) {
  const entry = cache.get(sessionId);
  if (!entry) return;
  entry.cleanup();
  entry.wrapper.remove();
  entry.term.dispose();
  cache.delete(sessionId);
}
