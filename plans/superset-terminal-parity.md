# Plan: Terminal — Superset parity analysis

> **Implementing?** Read `plans/superset-terminal-parity-implementation.md`
> — the self-contained build spec for all phases (exact sequences, IPC
> touchpoints, tests, acceptance). This document is the analysis behind it.

Feature-by-feature analysis of the Superset desktop terminal (reference
checkout at `reference/superset-main`) against WPHerd's Agents-screen
terminal, and the recommended implementation list. Companion to
`plans/superset-file-explorer-parity.md` (whose Phases 1–5 have shipped);
the closing section here lists the small explorer gaps that remain.

Superset reference paths (all under `apps/desktop/src/renderer/`):

- `lib/terminal/` — clipboard shortcuts, key-event handler, line-edit
  translations, image-paste fallback, addons, link stack, appearance.
- `screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/`
  — the v1 terminal component: `Terminal.tsx`, `helpers.ts` (xterm
  creation + copy/click-to-move/focus handlers), `config.ts` (xterm
  options), `TerminalSearch/`, `ScrollToBottomButton/`, `hooks/`,
  `link-providers/`.
- `routes/.../v2-workspace/$workspaceId/hooks/usePaneRegistry/components/TerminalPane/`
  — the v2 pane: rich input, session dropdown, link hover/click hints.
- `hotkeys/registry.ts` — terminal shortcut assignments.

## WPHerd terminal today (`src/components/Terminal.jsx`)

xterm + FitAddon only: theme flip with macOS appearance, 13px `MONO_STACK`
font, block cursor, ring-buffer replay on attach (~1 MB, main-process pty
per ADR 0001), resize via ResizeObserver, "Session ended" overlay with a
Close button. Session tabs per site live in `AgentsPane.jsx`. There is no
clipboard/keyboard handling, search, links, scrollback tuning, WebGL,
unicode11, or paste handling of any kind — everything below is a gap.

---

## Superset terminal feature inventory

### A. Copy / paste / clipboard

| # | Feature | Superset source | Notes |
| - | ------- | --------------- | ----- |
| A1 | **Cmd-chord bubbling** — a custom `attachCustomKeyEventHandler` short-circuits xterm's key encoder so every macOS `Cmd+…` chord bubbles to the host (Electron menu / browser clipboard pipeline) instead of being kitty/CSI-u-encoded and leaking literal sequences into TUIs. This is what makes plain **Cmd+C / Cmd+V** work in Claude Code et al. | `lib/terminal/terminal-key-event-handler.ts`, `clipboard-shortcuts.ts` | Ghostty rule: "on macOS, command+keys do not encode text". Win/Linux branch bubbles selectively (Ctrl+C only with a selection, since it doubles as SIGINT; Ctrl+Shift+C/V; Shift+Insert). |
| A2 | **Cmd+A selects all** terminal contents (VS Code's mac binding) instead of reaching the shell | `clipboard-shortcuts.ts` `shouldSelectAllShortcut` | |
| A3 | **Copy trims trailing whitespace** per line — intercepts the `copy` event and rewrites `clipboardData` so padded terminal lines don't paste with trailing spaces | `Terminal/helpers.ts` `setupCopyHandler` | Fallback to `navigator.clipboard.writeText` when `clipboardData` is null. |
| A4 | **OSC 52 clipboard** — `@xterm/addon-clipboard` with a UTF-8-safe base64 codec, so TUIs (vim, tmux, agents) can write the system clipboard | `lib/terminal/terminal-addons.ts`, `clipboard-base64.ts` | Custom codec fixes xterm #4839 (non-ASCII corruption). |
| A5 | **Image/file paste fallback** — pasting a screenshot or copied file (clipboard has `files` but no `text/plain`) sends literal `Ctrl+V` (`\x16`) to the PTY so Claude Code / Codex / opencode attach the image, instead of xterm emitting empty bracketed-paste markers | `lib/terminal/terminal-image-paste-fallback.ts` | Capture-phase `paste` listener on the wrapper preempts xterm's handler. Mirrors iTerm's "Paste or send ^V". |
| A6 | **Bracketed-paste-aware multiline submit** — the rich-input composer submits a multiline prompt via `xterm.paste(text)` (one literal block under bracketed paste) followed by `\r` | `TerminalPane/components/TerminalRichInput/` | Also used for "send to agent" flows. |

### B. Keyboard & line editing

| # | Feature | Superset source | Notes |
| - | ------- | --------------- | ----- |
| B1 | **Shift+Enter / Cmd+Enter → `ESC CR`** — the newline sequence Claude Code's `/terminal-setup` installs; Codex/Gemini/OpenCode parse it as insert-newline. Sent directly so it never depends on the kitty handshake | `lib/terminal/line-edit-translations.ts` | The single most important chord for an agent terminal. |
| B2 | **Mac line-edit chords**: Cmd+Backspace → `^U` (kill line), Cmd+Left → `^A`, Cmd+Right → `^E`, Option+Left/Right → `ESC b`/`ESC f` (word jump) | same | Windows: Ctrl+Left/Right → word jump. |
| B3 | `macOptionIsMeta: false` so Option+key still types intl characters (e.g. Option+2 = @) | `Terminal/config.ts` | |
| B4 | **Click-to-move cursor** on the prompt line — click on the current line sends the right number of arrow-key sequences; disabled in alternate screen, with a selection, or with modifiers | `helpers.ts` `setupClickToMoveCursor` | |
| B5 | **Hotkeys**: Cmd+F find-in-terminal, Cmd+K clear (xterm.clear + backend scrollback clear), Cmd+Shift+↓ scroll-to-bottom, Cmd+T new terminal, Cmd+W close, Cmd+I rich input | `hotkeys/registry.ts`, `hooks/useTerminalHotkeys.ts` | Hotkey layer runs before xterm via the same custom key handler (A1). |

### C. Rendering & addons

| # | Feature | Superset source | Notes |
| - | ------- | --------------- | ----- |
| C1 | **WebGL renderer** with context-loss fallback to DOM, load deferred to rAF; once WebGL fails it's skipped for all later terminals (VS Code pattern) | `terminal-addons.ts`, `helpers.ts` | Big smoothness win for TUI-heavy output. |
| C2 | **Unicode11 addon** (`unicode.activeVersion = "11"`) — correct emoji/CJK cell widths | same | Agents emit lots of emoji; without it alignment breaks. |
| C3 | **Search addon + find bar** — overlay with incremental find, Enter/Shift+Enter next/prev, case-sensitivity toggle, match decorations, "No results", Esc closes | `TerminalSearch/TerminalSearch.tsx` | |
| C4 | **Image addon** — inline iTerm/sixel images | `terminal-addons.ts` | |
| C5 | **Ligatures addon** (toggleable per font settings) | same | |
| C6 | **Progress addon** (OSC 9;4) feeding UI progress state | same | |
| C7 | **Scrollback 5000** (`DEFAULT_TERMINAL_SCROLLBACK`), native scrollbar hidden (fit addon reserves its width otherwise), custom wheel handler | `config.ts`, `shared/constants.ts` | WPHerd is on xterm's default 1000 lines. |
| C8 | **Query-response suppression** — parser hooks swallow CPR / focus-report / mode-report responses so they never render as junk text | `suppressQueryResponses.ts` | |
| C9 | **Perf plumbing**: write coalescer + parser-idle gate (fit/resize only when the parser is idle) | `lib/terminal/write-coalescer.ts`, `parser-idle-gate.ts` | Only worth porting if WPHerd sees jank. |
| C10 | Flash-free theming: initial terminal theme read synchronously before store hydration; theme object swapped live on change | `helpers.ts` `getDefaultTerminalTheme` | WPHerd already swaps theme live via `onThemeChange`. |

### D. Links

| # | Feature | Superset source | Notes |
| - | ------- | --------------- | ----- |
| D1 | **File-path links** (VS Code's `terminalLocalLinkDetector` vendored): detects paths incl. `file:line:col` suffixes, validates against the fs via the main process, Cmd+click opens in the editor at line/col | `lib/terminal/links/local-link-detector.ts`, `terminal-link-manager.ts` | Resolver caches stat calls; relative paths anchored to the workspace root. |
| D2 | **URL links** incl. hard-wrapped multi-line URLs; Cmd+click opens in browser (or in-app browser per setting) | `Terminal/link-providers/url-link-provider.ts` | |
| D3 | **Word links** — bare filenames like `AGENTS.md` become links (lowest priority) | `links/word-link-detector.ts` | |
| D4 | OSC 8 hyperlink handling; hover hint tooltip teaching "Cmd+click to open" (shown max 2×/session) | `terminal-link-manager.ts`, `TerminalPane/hooks/useLinkClickHint` | |

### E. Session & lifecycle UX

| # | Feature | Superset source | Notes |
| - | ------- | --------------- | ----- |
| E1 | **xterm instance cache across tab switches** — the terminal opens into a detached wrapper div that's re-parented on mount, so switching tabs never disposes xterm or drops scroll position/images; the data stream keeps writing while hidden | `helpers.ts` `createTerminalInWrapper`, `v1-terminal-cache.ts` | WPHerd re-creates xterm per mount and replays the ring buffer — loses scroll position, selections, images; visible re-paint. |
| E2 | **Reconnect with backoff** (max 5 tries) + "[Connection lost. Reconnecting…]" line + connection indicator | `Terminal.tsx` | Less relevant: WPHerd's pty is in-process. |
| E3 | **Session-killed overlay with Restart**; typing into an exited terminal restarts it | `components/SessionKilledOverlay`, `useTerminalLifecycle` | WPHerd's exit overlay only offers Close. |
| E4 | **Close-confirm** when a terminal has a running process, with persisted "don't ask again" | `stores/terminal-close-confirm/` | WPHerd confirms only at app quit (ADR 0001). |
| E5 | **Tab titles**: OSC title changes + typed-command heuristic (`commandBuffer` — the echoed command becomes the tab name); **CWD tracking** via OSC 7 so new terminals inherit the cwd | `useTerminalLifecycle`, `commandBuffer.ts`, `parseCwd.ts` | WPHerd tabs are static agent names. |
| E6 | **Agent status** (working / permission / idle) surfaced on tabs & sidebar; Ctrl+C / Escape clears "working" state | `TerminalPane/hooks/useTerminalInterruptClear`, tabs store | Superset's primary signal is agent hook events; the interrupt-clear part is terminal-side. |
| E7 | Cold restore of a previous daemon session (scrollback snapshot + "restored" overlay), background-terminal reattach dropdown | `useTerminalColdRestore`, `TerminalSessionDropdown` | **Rejected for WPHerd** by ADR 0001 (no daemon). |
| E8 | **Scroll-to-bottom floating button**, visible only when scrolled up (tracks `viewportY < baseY` on write/scroll) | `ScrollToBottomButton/` | |

### F. Input extras & settings

| # | Feature | Superset source | Notes |
| - | ------- | --------------- | ----- |
| F1 | **Drag & drop into the terminal**: Finder file drops and internal file-tree drags insert shell-escaped path(s) (`shell-quote`) | `Terminal.tsx` `handleDrop` | Pairs naturally with WPHerd's Files tree. |
| F2 | **Rich input composer** (Cmd+I): Warp-style multiline editor overlay with @file mentions and per-terminal drafts; submits via bracketed paste + CR | `TerminalRichInput/` | |
| F3 | **Terminal appearance settings**: font family/size (validated/sanitized), line height, letter spacing, weight, ligatures toggle, min contrast, cursor style/blink; live re-fit + backend resize on change | `lib/terminal/appearance/`, settings router | |
| F4 | Focus-follows-terminal (textarea focus listener drives the app's focused-pane state) | `helpers.ts` `setupFocusListener` | WPHerd single-pane; matters only if panes multiply. |

---

## Recommendation — what WPHerd should implement

Everything targets `src/components/Terminal.jsx` (+ `electron/services/agents.cjs`
/ `ipc.cjs` / `preload.cjs` where noted). Phases are independent commits.

### Phase 1 — clipboard & keyboard correctness (do first; small, highest value)

1. **Custom key handler (A1 + A2)**: port `clipboard-shortcuts.ts` +
   `terminal-key-event-handler.ts` mac branch — bubble every Cmd chord,
   Cmd+A → `selectAll()`. WPHerd is macOS-only, so the Win/Linux branches
   can be dropped. This makes Cmd+C/Cmd+V behave natively.
2. **Line-edit translations (B1 + B2)**: Shift+Enter / Cmd+Enter → `\x1b\r`
   (multiline prompts in Claude Code), Cmd+Backspace/Left/Right → `^U`/`^A`/`^E`,
   Option+arrows → `ESC b/f`. Port `line-edit-translations.ts` nearly verbatim.
3. **Copy handler (A3)**: trim trailing whitespace per line on copy.
4. **Image paste fallback (A5)**: capture-phase paste listener → `\x16`.
   Essential for pasting screenshots into Claude Code.
5. **Options pass (B3 + C7)**: `macOptionIsMeta: false`, `scrollback: 5000`
   (and grow the main-process ring buffer replay accordingly if needed),
   `allowProposedApi` already set.

### Phase 2 — daily-driver usability

6. **Search (C3)**: `@xterm/addon-search` + a find bar mirroring
   `TerminalSearch.tsx` (Cmd+F, Enter/Shift+Enter, case toggle, Esc).
   Style with `.panel` + semantic tokens.
7. **Clear terminal (B5)**: Cmd+K → `xterm.clear()` + new IPC to reset the
   session's ring buffer in `agents.cjs` (otherwise reattach replays the
   cleared content).
8. **Scroll-to-bottom button (E8)** + Cmd+Shift+↓.
9. **Renderer/addons (C1 + C2 + A4)**: WebGL with DOM fallback (copy the
   `suggestedRendererType` pattern), Unicode11, ClipboardAddon with the
   Utf8Base64 codec.
10. **URL links (D2, simplified)**: start with `@xterm/addon-web-links`
    (Cmd+click gating via its callback) rather than porting the multi-line
    provider; open via `shell.openExternal`.
11. **Exit overlay Restart (E3)**: add a Restart button that spawns a fresh
    pty for the same Session (agents.cjs already knows the spec), and let
    typing into an exited focused terminal restart it.

### Phase 3 — deeper parity (worth it, more work)

12. **Keep xterm alive across tab switches (E1)**: adopt the detached-wrapper
    cache so switching Sessions/sites doesn't rebuild the terminal. This
    replaces most uses of the replay path (replay stays for window reopen).
13. **File-path links (D1)**: port the local-link detector with a
    `stat`-over-IPC resolver (confine to the site root via
    `files.assertInRoot`) and open matches in WPHerd's CodeEditor at
    line/col. High leverage — agents constantly print `path:line`.
14. **Drag & drop into terminal (F1)**: Finder drops + Files-tree drags →
    shell-escaped paths written to the pty.
15. **Tab title & cwd (E5)**: `onTitleChange` → session tab label;
    OSC 7 cwd parse is optional (WPHerd sessions are site-rooted anyway).
16. **Per-tab close confirm (E4)** with persisted suppression, replacing the
    bare `X` kill on session tabs.
17. **Query-response suppression (C8)**: cheap port, prevents stray `;1R`
    artifacts after reattach.

### Explicitly not recommended

- **Daemon cold restore / session dropdown / reconnect transport (E2, E7)** —
  contradicts ADR 0001's no-daemon decision; WPHerd's pty is in-process.
- **Rich input composer (F2)**, **progress addon (C6)**, **appearance
  settings UI (F3)**, **agent status via hook events (E6)** — real features,
  but each is a product decision beyond terminal parity; revisit after
  Phases 1–3. Ligatures/images (C4, C5) are take-it-or-leave-it addon
  one-liners that can ride along with Phase 2 item 9 if desired.
- **Perf plumbing (C9)** — only if profiling shows a need.

---

## File explorer — remaining gaps (after shipped Phases 1–5)

Superset's current explorer (`FilesTab` on `@pierre/trees`) adds, beyond
what WPHerd already shipped (tabs, lazy tree, search filter, new
file/folder, inline rename, panel delete confirm, context menus, Changes
sections/view modes/diff viewer/stage-unstage-discard, git decorations,
drag-drop upload, nested repos):

1. **"Open in New Tab"** context item — trivial; WPHerd's editor already
   has tabs.
2. **Reveal active editor file in the tree** (expand ancestors +
   scroll-to-row when the active editor tab changes).
3. **Virtualized rows** — Superset renders through a virtualized tree;
   WPHerd renders all expanded rows. Only matters for huge `wp-content`
   trees; defer until it's felt.
4. **Tree keyboard navigation** (arrow keys expand/collapse/move).
5. Cosmetic: scroll-fade edges, full-pane drop overlay (WPHerd's drag-drop
   shipped without the overlay treatment).

Still out of scope (Superset's PR/worktree product): base-branch selector,
commit filter, Review/PR tab, external-editor integration.
