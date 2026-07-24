# Plan: Terminal — Superset parity implementation (Phases 1–4)

Implementation spec for bringing WPHerd's Agents-screen terminal up to
Superset parity, per the analysis in `plans/superset-terminal-parity.md`.
**Written so a fresh session can implement every phase without the
reference checkout** — all escape sequences, predicates, and algorithms are
inlined below. (If `reference/superset-main` exists locally it is the
gitignored Superset source; the analysis doc maps each feature to its file
there, but nothing below requires it.)

Read first, in this order:

1. `CLAUDE.md` — the IPC three-touchpoint pattern, semantic-token /
   dark-mode rules, and `.btn` / `.panel` conventions are binding.
2. `docs/adr/0001-main-process-pty-no-daemon.md` — Sessions are
   main-process ptys with a ring buffer; **no daemon, no cross-restart
   survival**. Nothing in this plan may introduce one.
3. `src/components/Terminal.jsx` — the whole surface being changed
   (~95 lines today: xterm + fit + theme flip + replay + exit overlay).
4. `src/components/AgentsPane.jsx` — owns session tabs
   (`tabs`/`activeTab`), mounts `<Terminal key={activeTab}>`, owns editor
   tabs (`openFiles`/`activeKey`, `openFile()`).
5. `electron/services/agents.cjs` — pty supervisor: `sessions` Map
   (`sessionId → { pty, buffer, window, exited, siteId, agentId,
   agentName, started }`), `MAX_BUFFER` 1 MB, `launch/attach/write/resize/
   stop`.
6. `electron/ipc.cjs` (terminal handlers ~line 165–195) and
   `electron/preload.cjs` (`VALID_EVENT_CHANNELS`, `terminal*` methods,
   `on`/`off` at the bottom).
7. `src/lib/theme.js` (`terminalThemes`, `MONO_STACK`, `onThemeChange`)
   and, for Phase 3b, `src/components/CodeEditor.jsx` +
   `electron/services/files.cjs` (`assertInRoot`).

## Hard constraints (do not violate)

1. **Stage files explicitly by name** — never `git add -A` / `git add .`.
   Never commit `reference/` or unrelated local changes (historically
   `electron/services/brew.cjs` carried one — check `git status` first).
2. **WPHerd is on `@xterm/xterm` 5.5.0 stable; Superset is on 6.1.0-beta.**
   Do NOT copy 6.x-only options — there is no `vtExtensions` (kitty
   keyboard) and no `scrollbar: { showScrollbar }` in 5.5. Do not upgrade
   xterm; install the addon versions pinned in each phase (they are the
   stable releases matching core 5.5).
3. **macOS-only app** — implement only the mac branches of Superset's
   platform switches; drop Windows/Linux paths.
4. Every new IPC follows the three-touchpoint pattern (`ipc.cjs` handler →
   `preload.cjs` wrapper → renderer call), and every handler that takes a
   filesystem path resolves it through `files.assertInRoot(rootPath, p)`.
5. ADR 0001 stands: no pty daemon, no reconnect transport, no cold restore
   across app restarts. The Phase 3a cache is renderer-side only.
6. Styling: semantic tokens only (`accent` = gray hover, `highlight` =
   blue); menus/overlays use `.panel`; buttons use `.btn`/`.btn-*`; no
   `dark:` variants (tokens flip themselves). Terminal sits on
   `bg-background`.
7. Pure logic goes in `src/lib/terminal/` as plain JS modules with vitest
   coverage in `test/` (vitest config already picks up `test/**`); React
   glue stays in `Terminal.jsx`. Keep helpers dependency-free.
8. Main-process changes need an Electron restart; renderer changes
   hot-reload. Dev: `npm run dev`. Verify each phase with `npm run test`
   and `npm run lint` before committing. Commit per phase,
   `feat(agents): …` style.

## New dependencies (renderer-side, install per phase as noted)

| Package | Version | Phase |
| ------- | ------- | ----- |
| `@xterm/addon-clipboard` | `^0.1.0` | 1 |
| `@xterm/addon-search` | `^0.15.0` | 2 |
| `@xterm/addon-webgl` | `^0.18.0` | 2 |
| `@xterm/addon-unicode11` | `^0.8.0` | 2 |
| `@xterm/addon-web-links` | `^0.11.0` | 2 |

No other new deps. (Image/ligature addons are explicitly out of scope —
see "Not in scope".)

---

## Phase 1 — Clipboard & keyboard correctness

### 1a. `src/lib/terminal/keys.js` (new, pure)

Export three functions. All take a DOM `KeyboardEvent` (or a plain object
with the same fields — that's what the tests pass).

```js
// Cmd+A → select all terminal contents (VS Code's mac binding).
isSelectAllChord(e)
// e.code === 'KeyA' && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
```

```js
// Line-edit chords → the byte sequence to send to the pty, or null.
// CONTRACT: match named keys via e.key (layout-stable); never match
// printable characters via e.key (breaks non-US layouts) — use e.code.
translateLineEditChord(e)
```

| Chord | Condition | Returns | Why |
| ----- | --------- | ------- | --- |
| Shift+Enter | `key==='Enter'`, shift only modifier | `'\x1b\r'` | ESC+CR — the insert-newline sequence Claude Code's `/terminal-setup` installs; Codex/Gemini/OpenCode parse it as Alt+Enter. Sent directly so multiline prompts never depend on a terminal handshake. |
| Cmd+Enter | `key==='Enter'`, meta only | `'\x1b\r'` | same |
| Cmd+Backspace | `key==='Backspace'`, meta only | `'\x15'` | `^U` kill-line |
| Cmd+← | `key==='ArrowLeft'`, meta only | `'\x01'` | `^A` line start |
| Cmd+→ | `key==='ArrowRight'`, meta only | `'\x05'` | `^E` line end |
| Option+← | `key==='ArrowLeft'`, alt only | `'\x1bb'` | word back |
| Option+→ | `key==='ArrowRight'`, alt only | `'\x1bf'` | word forward |

"meta only" = `metaKey && !ctrlKey && !altKey && !shiftKey`; "alt only"
analogous. Anything else → `null`.

```js
// True when the chord must bubble past xterm to the browser/Electron
// (clipboard pipeline, app shortcuts). Mac rule (Ghostty): every Cmd
// chord bubbles — Cmd+keys never encode text into the pty.
shouldBubbleChord(e)  // → e.metaKey
```

### 1b. Install the handler in `Terminal.jsx`

Right after `term.open(...)`, attach:

```js
term.attachCustomKeyEventHandler((e) => {
  const seq = translateLineEditChord(e);
  if (seq !== null) {
    if (e.type === 'keydown') { e.preventDefault(); term.input(seq, true); }
    return false;
  }
  if (isSelectAllChord(e)) {
    if (e.type === 'keydown') { e.preventDefault(); term.selectAll(); }
    return false;
  }
  if (shouldBubbleChord(e)) return false; // NO preventDefault — the browser
  // keydown → paste pipeline is what fires xterm's paste; we only skip
  // xterm's own key encoder.
  return true;
});
```

Order matters: translations run before the bubble check (they are Cmd/Option
chords the terminal *does* want). Phase 2 inserts its Cmd+F/K/Shift+↓
branches between select-all and the bubble check.

### 1c. Copy trims trailing whitespace

Terminals pad lines to the grid width, so naive copy pastes trailing
spaces. Add to `src/lib/terminal/keys.js` (or a small `clipboard.js`):

```js
trimSelection(text) // text.split('\n').map((l) => l.replace(/\s+$/,'')).join('\n')
```

In `Terminal.jsx`, after open, register on `term.element`:

```js
const onCopy = (e) => {
  const sel = term.getSelection();
  if (!sel) return;
  const trimmed = trimSelection(sel);
  if (e.clipboardData) { e.preventDefault(); e.clipboardData.setData('text/plain', trimmed); }
  else navigator.clipboard?.writeText(trimmed).catch(() => {});
};
term.element.addEventListener('copy', onCopy);
```

Remove in the effect cleanup.

### 1d. Image/file paste fallback

Pasting a screenshot or copied file gives a clipboard with `files` but no
`text/plain`; xterm then emits empty bracketed-paste markers and agents
never see the image. Mirror iTerm's "Paste or send ^V": forward literal
Ctrl+V so Claude Code/Codex/opencode grab the image from the clipboard
themselves.

`src/lib/terminal/keys.js`:

```js
isNonTextPaste(e) // e.clipboardData && !e.clipboardData.getData('text/plain')
                  //   && (e.clipboardData.files?.length ?? 0) > 0
```

`Terminal.jsx` — **capture-phase** listener on the outer wrapper div (must
run before xterm's own paste listeners; `stopImmediatePropagation` preempts
the bracketed-paste wrap):

```js
const onPaste = (e) => {
  if (!isNonTextPaste(e)) return;
  e.preventDefault(); e.stopImmediatePropagation();
  term.input('\x16', true);
};
wrapperEl.addEventListener('paste', onPaste, { capture: true });
```

Guard the trigger on `files.length > 0` exactly — a broader "any non-text
MIME" heuristic over-fires on `text/html`-only clipboards and makes Codex
toast "Failed to paste image".

### 1e. Options pass + OSC 52 clipboard

- xterm options: add `scrollback: 5000` and `macOptionIsMeta: false`
  (explicit — Option+2 must still type `@` on intl layouts). Keep the
  existing cursor/theme/font options.
- `npm i @xterm/addon-clipboard@^0.1.0`. Load it with a UTF-8-safe base64
  codec (the addon's default `btoa`/`atob` codec mojibakes multi-byte
  characters — xterm #4839). New `src/lib/terminal/utf8Base64.js`:

```js
export class Utf8Base64 {
  encodeText(data) {
    const bytes = new TextEncoder().encode(data);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  decodeText(data) {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // fatal: throw on non-UTF-8 rather than write replacement chars;
    // the addon catches and clears (strict decode, like kitty/alacritty).
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
}
```

`term.loadAddon(new ClipboardAddon(new Utf8Base64()))`. This lets tmux/vim
/agents write the system clipboard via OSC 52.

### 1f. Tests (`test/terminal-keys.test.js`)

Pure-unit the whole of 1a–1d: every row of the chord table (plus negative
cases: Cmd+Shift+Enter → null, plain Enter → null, Ctrl+A → null);
`isSelectAllChord` positive/negative; `shouldBubbleChord` (Cmd+C true,
Ctrl+C false); `trimSelection` (trailing spaces/tabs stripped, interior
whitespace and newlines preserved); `isNonTextPaste` with stub
clipboardData objects (text present → false, files empty → false, files
present + no text → true); `Utf8Base64` round-trips ASCII and `"héllo 日本"`
and throws on invalid UTF-8 bytes.

**Acceptance:** in a live Claude Code session — Shift+Enter inserts a
newline in the prompt instead of submitting; Cmd+A selects the whole
buffer; Cmd+C/Cmd+V copy/paste cleanly (no stray sequences typed into the
TUI); copying a padded line pastes without trailing spaces; pasting a
macOS screenshot (Cmd+Ctrl+Shift+4 then Cmd+V) attaches the image in
Claude Code; Cmd+Backspace clears the input line.

---

## Phase 2 — Daily-driver usability

### 2a. Search (Cmd+F)

`npm i @xterm/addon-search@^0.15.0`. Load `SearchAddon` alongside fit.

New `src/components/TerminalSearchBar.jsx`, rendered by `Terminal.jsx`
absolutely positioned top-right inside the wrapper (`absolute top-1
right-2 z-10`), on `.panel` with `flex items-center gap-1 px-2 py-1`:

- Text input (`.form-input`-adjacent but compact: transparent bg, 12.5px,
  no border, `focus:outline-none`, width ~7rem), autofocus + select-all on
  open.
- Incremental: `onChange` → `findNext(q, opts)`; empty query →
  `clearDecorations()`. Show a muted "No results" label when the last find
  returned false and the query is non-empty.
- Buttons (icon-only, lucide 13px, `text-muted-foreground
  hover:text-foreground`): case-toggle (`CaseSensitive` icon; active state
  `text-highlight`), prev (`ChevronUp`), next (`ChevronDown`), close (`X`),
  each in a `Tooltip`.
- Keys on the input: Enter → next, Shift+Enter → prev, Esc → close.
- Search options: `{ caseSensitive, regex: false, decorations: {
  matchBackground: '#515c6a', matchBorder: '#74879f',
  matchOverviewRuler: '#d186167e', activeMatchBackground: '#515c6a',
  activeMatchBorder: '#ffd33d', activeMatchColorOverviewRuler: '#ffd33d' } }`
  (canvas colors, not CSS — literals are fine here, same in both themes).
- On close: `clearDecorations()` and refocus the terminal.

Open/close state lives in `Terminal.jsx`; wire **Cmd+F** as a new branch in
the custom key handler (before the bubble check): `e.code === 'KeyF' &&
meta-only` → on keydown `preventDefault()`, set search open; `return false`.

### 2b. Clear terminal (Cmd+K)

Clearing only xterm would resurrect old content on the next replay, so the
ring buffer must clear too:

1. `agents.cjs`: `clearBuffer(sessionId)` → `session.buffer = ''` (no-op
   if no session). Export it.
2. `ipc.cjs`: `ipcMain.on('terminal-clear', (_e, sessionId) =>
   agents.clearBuffer(sessionId))` next to the other terminal channels.
3. `preload.cjs`: `terminalClear: (sessionId) =>
   ipcRenderer.send('terminal-clear', sessionId)`.
4. `Terminal.jsx` key handler branch: `e.code === 'KeyA'`… no — `'KeyK'`
   meta-only → keydown: `term.clear(); api.terminalClear(sessionId)`;
   `return false`.

### 2c. Scroll-to-bottom button + Cmd+Shift+↓

New tiny component inside `Terminal.jsx` (state + JSX, no separate file
needed): a floating circular button, `absolute bottom-3 left-1/2
-translate-x-1/2 z-10`, `.panel rounded-full w-8 h-8 flex items-center
justify-center text-muted-foreground hover:text-foreground`, lucide
`ArrowDown` 14px, fading in/out with
`transition-opacity` + `pointer-events-none opacity-0` when hidden.

Visibility: track with `term.onWriteParsed(check)` and
`term.onScroll(check)` where `check` sets
`visible = term.buffer.active.viewportY < term.buffer.active.baseY`.
Click and the key-handler branch (`key === 'ArrowDown'`, meta+shift only)
call `term.scrollToBottom()`.

### 2d. Renderer & unicode addons

`npm i @xterm/addon-webgl@^0.18.0 @xterm/addon-unicode11@^0.8.0`.

- Unicode11: load addon, then `term.unicode.activeVersion = '11'` —
  correct emoji/CJK widths (agents emit both constantly).
- WebGL, VS Code pattern, in `src/lib/terminal/webgl.js` or inline:
  module-level `let webglFailed = false`. After `term.open()`, inside
  `requestAnimationFrame` (avoids racing xterm's post-open viewport sync):
  if `webglFailed` skip; else `try { addon = new WebglAddon();
  addon.onContextLoss(() => { addon.dispose(); webglFailed = true;
  term.refresh(0, term.rows - 1); }); term.loadAddon(addon); } catch {
  webglFailed = true; }`. Dispose the addon and cancel the rAF in cleanup.

### 2e. URL links (Cmd+click)

`npm i @xterm/addon-web-links@^0.11.0`.

```js
term.loadAddon(new WebLinksAddon((event, uri) => {
  if (!event.metaKey) return;            // Cmd+click only — plain click
  window.electronAPI.openSiteInBrowser(uri); // must not hijack the TUI
}));
```

(`openSiteInBrowser` already exists → `open-in-browser` →
`shell.openExternal`.) The addon underlines on hover by itself.

### 2f. Exit overlay: Restart

Today the overlay only offers Close. Add a primary **Restart** button that
respawns the same Agent in place (same tab position, new sessionId):

- `AgentsPane.jsx`: add `respawn(sessionId)` — find the tab, call
  `window.electronAPI.launchAgent(siteId, tab.agentId)`, then replace that
  tab's entry in `tabs` with the new sessionId (same index) and
  `setActiveTab(newId)`. Old session is already exited (shell died), but
  call `terminalStop(oldId)` anyway to delete it from the sessions Map.
- `Terminal.jsx`: new prop `onRestart`; overlay buttons become
  `btn-primary` Restart + `btn-secondary` Close.

**Acceptance:** Cmd+F finds and highlights text with working next/prev/
case/Esc; Cmd+K clears and the content stays gone after switching tabs
away and back (ring buffer really cleared); scrolling up shows the float
button, clicking or Cmd+Shift+↓ returns to bottom and the button fades;
`htop`-style TUIs render noticeably smoother (WebGL active — verify via
`document.querySelector('canvas')` count or by the addon not throwing);
emoji-heavy agent output aligns correctly; Cmd+clicking an `http(s)://` URL
in output opens the browser, plain click does nothing; the exit overlay's
Restart brings back the same agent in the same tab.

---

## Phase 3 — Deeper parity

Land as separate commits in this order: 3a (cache) first — 3b/3d build on
its structure.

### 3a. Keep xterm alive across tab switches (renderer-side cache)

Today `<Terminal key={activeTab}>` disposes xterm on every tab switch and
replays the ring buffer — losing scroll position and selection and
repainting visibly. Adopt Superset's detached-wrapper cache (their
`createTerminalInWrapper` / v1-terminal-cache), renderer-side only:

**Prerequisite — preload event API.** `electronAPI.off(channel)` currently
does `removeAllListeners(channel)`; with several live terminals subscribed
to `terminal-data`, one unmount would deafen the rest. Change `on(channel,
cb)` to return an unsubscribe function that removes only its own wrapped
listener (`ipcRenderer.removeListener(channel, wrapped)`). Keep `off` for
existing callers (grep: Services/Dashboard/etc. use `on`/`off` — leave
their behavior intact; only terminal code switches to the returned
unsubscribe).

**New `src/lib/terminal/sessionCache.js`** — module-level
`Map<sessionId, entry>`:

```
entry = { term, fit, searchAddon, wrapper, unsubs: [fn], exited: false }
```

- `getOrCreate(sessionId, makeTerm)`: on miss, create the xterm with all
  Phase 1/2 addons/handlers **into a detached `div` wrapper**
  (`wrapper.style.width = wrapper.style.height = '100%'`;
  `term.open(wrapper)`), subscribe `terminal-data` / `terminal-exit` /
  `terminal-replay` here (writes keep flowing while hidden), call
  `api.terminalReady(sessionId)` once for the initial replay, and store
  the unsubscribes.
- `attach(sessionId, containerEl)`: `containerEl.appendChild(wrapper)`,
  `fit.fit()`, push resize.
- `detach(sessionId)`: `wrapper.remove()` — xterm and listeners stay live.
- `dispose(sessionId)`: run `unsubs`, `term.dispose()`, delete the entry.

**`Terminal.jsx`** becomes glue: `getOrCreate` + `attach` on mount,
`detach` on unmount, `dispose` only when the session is closed
(`AgentsPane.closeTab` → call `sessionCache.dispose(sessionId)` after
`terminalStop`; also dispose all entries for a site when leaving the
Agents screen is NOT wanted — background sessions keep buffering, that's
the point). The exit overlay state moves to React state fed by a
cache-registered callback (`entry.onExit = setExit`-style ref updated on
mount). Theme flips (`onThemeChange`) must now iterate all cached
terminals, not just the mounted one — register one module-level watcher in
`sessionCache.js` that sets `entry.term.options.theme` for every entry.

Window-reopen replay still works: the cache lives in the renderer, and the
window is hidden (not destroyed) on close per `main.cjs`, so nothing is
lost; keep `terminal-ready`'s replay path for the cache-miss case.

`ResizeObserver` stays in `Terminal.jsx` (observes the live container).

### 3b. File-path links → CodeEditor

Custom xterm link provider (regex + IPC stat validation), Cmd+click opens
the file in WPHerd's editor at the line. Agents print `path:line` targets
constantly, so this is the highest-leverage link feature.

1. **IPC `terminal-stat-path`** (three touchpoints). Handler
   `(rootPath, candidate)`:
   - Expand a leading `~` only if it resolves inside the root (in
     practice: reject `~` — site paths never need it).
   - Resolve relative candidates against `rootPath`; then
     `files.assertInRoot(rootPath, resolved)` — anything outside the site
     root returns `{ exists: false }` (defense in depth; never throw).
   - `fs.statSync` → `{ exists, isDirectory, resolved }`.
2. **`src/lib/terminal/fileLinkProvider.js`** — implements xterm's
   `registerLinkProvider` contract (`provideLinks(lineNo, cb)`):
   - Read the line via `term.buffer.active.getLine(lineNo - 1)
     .translateToString(true)`; skip lines > 2000 chars.
   - Candidate regex (single line, global). Keep it deliberately simpler
     than VS Code's vendored parser:
     ```
     /(?:^|[\s"'`([])((?:~?\/)?[\w.-]+(?:\/[\w.-]+)+\/?|[\w-]+\.[A-Za-z]{1,8})(?::(\d+))?(?::(\d+))?/g
     ```
     Group 1 path (anything with a `/`, or a bare `name.ext` word — the
     "AGENTS.md" case), groups 2/3 optional `:line:col`.
   - Validate each candidate through the stat IPC, with a module-level
     `Map<candidate, Promise>` cache (cap ~500 entries, clear on site
     change) so repeated frames don't re-stat. Cap 10 resolved links per
     line. Non-existent → not a link.
   - Emit `{ range, text, activate(event) }` per match (xterm ranges are
     1-based, inclusive); `activate` requires `event.metaKey`, then calls
     the injected `onOpen(resolved, line, col, isDirectory)`. Directories:
     ignore (or reveal in Files tree if trivially wirable).
   - `hover`/`leave` callbacks optional — xterm underlines by default.
3. **Wiring**: `sessionCache.getOrCreate` takes `{ rootPath, onOpenFile }`
   from `Terminal.jsx` props (pass them via refs so the cached provider
   always calls the current handler — Superset does exactly this with
   `handleFileLinkClickRef`). `AgentsPane` passes `onOpenFile` = open/focus
   an editor tab for `{ path, name }` **plus a `line` field**.
4. **CodeEditor line jump**: file tab entries gain optional `line`
   (1-based). In `CodeEditor.jsx`, when the active file's content loads
   and `line` is set, move the selection and scroll:
   `view.dispatch({ selection: { anchor: view.state.doc.line(min(line,
   lines)).from }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })`
   — grab the `EditorView` from `@uiw/react-codemirror`'s
   `onCreateEditor`/ref. Re-opening an already-open tab with a new line
   re-jumps (update the entry's `line`, effect keys on it).

### 3c. Drag & drop into the terminal

On the terminal wrapper in `Terminal.jsx`:

- `onDragOver`: `preventDefault()`, `dropEffect = 'copy'`.
- `onDrop`: `preventDefault()`. Finder drops: `[...e.dataTransfer.files]
  .map((f) => f.path)` — Electron 28 still has `File.path` (do NOT use
  `webUtils.getPathForFile`; that's Electron ≥ 32). Internal drags (Files
  tree): fall back to `e.dataTransfer.getData('text/plain')`. Shell-escape
  each path — new pure helper `shellEscape(paths)` in
  `src/lib/terminal/keys.js`: wrap each in single quotes with embedded
  `'` → `'\''`, join with spaces — and `api.terminalInput(sessionId,
  escaped)`.
- `FileExplorer.jsx`: make file rows `draggable` with
  `onDragStart={(e) => e.dataTransfer.setData('text/plain', entry.path)}`
  (folders too). This must not interfere with the existing drop-upload
  target: internal drags carry `text/plain` and no `files`, so the
  existing upload handler (which reads `dataTransfer.files`) should
  early-return when `files.length === 0`.

Tests: `shellEscape` (spaces, quotes, unicode).

### 3d. Session tab titles (OSC) 

`term.onTitleChange((title) => onTitle?.(title))` registered in the cache,
forwarded to `AgentsPane` via ref-prop like `onOpenFile`. `AgentsPane`
keeps `titles` state (`sessionId → string`); tab label =
`titles[id] || agentName + ordinal`. Claude Code sets titles like
`✳ short task summary`; strip a leading emoji/symbol + space
(`/^[\p{Emoji}\p{Symbol}]\s*/u`) before display. Cap with the existing
`truncate max-w-[140px]`.

Skip Superset's typed-command heuristic (`commandBuffer`) and OSC 7 cwd
tracking — WPHerd sessions are site-rooted and agent-named; titles from
OSC are enough.

### 3e. Per-tab close confirm

`closeTab` currently kills instantly. Reuse `ConfirmDialog` from
`src/components/ui.jsx` (built in explorer Phase 5):

- Only when the session hasn't exited (track exited sessionIds in
  `AgentsPane` via the cache's exit callback; an exited tab closes
  without asking).
- Copy: title "End session?", description "This will terminate the
  running agent in [Agent Name]. Anything it is doing will be
  interrupted.", confirm "End Session", danger.
- "Don't ask again" checkbox → `localStorage`
  `wpherd.terminalCloseConfirmSuppressed = '1'`; suppressed → close
  immediately. (No settings UI to reset it — acceptable, note in code.)

### 3f. Query-response suppression

After creating the terminal (in the cache factory), register parser hooks
so device-status replies never render as junk after replay/reattach
(`;1R`-type artifacts):

```js
const p = term.parser;
p.registerCsiHandler({ final: 'R' }, () => true);                    // CPR reply (query ends 'n')
p.registerCsiHandler({ final: 'I' }, () => true);                    // focus-in report
p.registerCsiHandler({ final: 'O' }, () => true);                    // focus-out report
p.registerCsiHandler({ intermediates: '$', final: 'y' }, () => true); // DECRPM mode report
```

Do NOT suppress CSI `c` or `t` (query and response share the final byte —
suppressing breaks the queries themselves).

**Acceptance (Phase 3):** switch between two session tabs — no repaint
flash, scroll position and selection survive, output produced while hidden
is present; Cmd+click a `wp-content/...php:42`-style path in agent output
→ editor opens that file with line 42 centered; a path outside the site
root (e.g. `/etc/hosts`) is not linkified; drag a file from the Files tree
or Finder onto the terminal → quoted path appears at the prompt; a Claude
Code session renames its tab; closing a live tab asks once, "don't ask
again" sticks; no stray `;R` artifacts after switching tabs during heavy
output.

---

## Phase 4 — File-explorer leftovers

Small items completing `plans/superset-file-explorer-parity.md`:

### 4a. Reveal active editor file in the tree

When `activeKey` in `AgentsPane` changes to a `kind:'file'` tab, pass
`activeFilePath` down to `FileExplorer`. There: compute the rel path
(`path.relative`-equivalent string math — renderer has no `path`), expand
each ancestor directory in turn (await the existing per-directory
`listDirectory` loads), then `scrollIntoView({ block: 'nearest' })` the
row and give it the selected style (`bg-accent` while it is the active
file — a `data-active` row state, not a flash). Debounce: only act when
the Files tab is the visible tab; don't steal the user's scroll while they
are in the Changes tab.

### 4b. Tree keyboard navigation

Roving selection over the *visible* rows of the Files tree (flatten the
rendered tree order into an array):

- ArrowDown/ArrowUp move the selection; Home/End jump.
- ArrowRight: collapsed dir → expand; expanded dir → move into first
  child; file → no-op.
- ArrowLeft: expanded dir → collapse; else → move to parent row.
- Enter: file → open in editor; dir → toggle.
- The tree container gets `tabIndex={0}` + `onKeyDown`; selection is
  component state (`selectedPath`), visualized with the same row highlight
  as 4a; typing in the search input must not trigger it (keydown handler
  only on the tree scroller).

### 4c. Cosmetic (optional, only if time permits)

Full-pane drop overlay while a Finder drag hovers the Files tree ("Drop
to upload to *dir*", `.panel` inset overlay, `border-highlight` dashed) —
the upload logic already shipped; this is presentation only.

**Not doing** (unchanged from the analysis): virtualized rows (revisit
only if large `wp-content` trees measurably lag), "Open in New Tab"
(WPHerd has no preview-tab concept — every open is already a real tab),
base-branch selector / commit filter / Review-PR tab / external editor.

---

## Not in scope (whole plan)

Daemon cold-restore, reconnect transport, background-session dropdown
(ADR 0001); rich-input composer; terminal appearance settings UI;
progress/image/ligature addons; agent hook-event status; write-coalescer /
parser-idle-gate perf plumbing (only port if profiling shows jank);
click-to-move-cursor (nice-to-have; skip — agents run TUIs where it's
disabled anyway).

## Sequencing & verification

One commit per phase (Phase 3 = one commit per sub-feature 3a–3f is also
fine). After each: `npm run test`, `npm run lint`, and a manual pass in
`npm run dev` against a real site with a real agent CLI (Claude Code) —
the acceptance list at the end of each phase is the manual script. Never
test destructive git/fs actions inside the WPHerd repo itself; use a
scratch site. Update `docs/features/FEATURES.md`'s baseline list once all
phases land (one line: terminal parity — search, links, clipboard/keys,
session cache).
