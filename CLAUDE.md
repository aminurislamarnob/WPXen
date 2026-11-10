# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Vite renderer (localhost:5173) + Electron in parallel (concurrently)
npm run vite         # Renderer only
npm run electron     # Electron only against an already-running renderer
npm run build        # vite build + electron-builder --mac → .dmg in release/ (arm64 + x64)
npm run build:renderer # vite build alone — what CI runs
npm run pack         # Unpacked build (electron-builder --dir), no installer
npm run test         # vitest run (tests live in test/, cover electron/services logic)
npm run lint         # eslint . (lint:fix to autofix)
npm run format       # prettier --write . (format:check to verify without writing)
```

There is no typechecker; the codebase is plain JS/JSX.

### CI

`.github/workflows/ci.yml` runs four steps **in order, each gating the next**:
`lint` → `format:check` → `test` → `build:renderer`. A formatting slip therefore
hides every test failure behind it — when a run goes red, check which step
stopped rather than assuming the first error is the only one. Run all four
locally before pushing.

⚠️ **Never `require('electron')` at module scope** in anything a test
imports — directly or transitively. Tests load main-process modules under plain
Node, where `electron`'s `index.js` runs `getElectronPath()` at module scope: it
resolves no API surface, and on a missing `path.txt` it **spawns a ~100MB binary
download**. Resolve the require lazily inside the function that uses it, the way
`siteops.cjs`, `blueprints.cjs`, `procman.cjs`, `browser.cjs` and `safeUrl.cjs`
do.

The enforcement is `test/no-module-scope-electron.test.js`, a ratchet with an
explicit per-file allowlist (the five entry points no test imports:
`main.cjs`, `preload.cjs`, `tray.cjs`, `store.cjs`, `ipc.cjs`). It only ever
tightens — exceeding a count fails, and dropping below one fails too, so the
entry has to be lowered in the same change. Historically the guard was CI's
`ELECTRON_SKIP_BINARY_DOWNLOAD=1`, which made a top-level require throw on the
runner; Electron 42 deleted the `postinstall` download and that env var with it,
so the failure became a silent download instead. Hence the ratchet.

## Architecture

WPXen is an Electron macOS menu-bar app that orchestrates Homebrew-installed services
(nginx, PHP-FPM, MySQL, dnsmasq, WP-CLI) to run local WordPress `.test` sites. It does
**not** bundle these binaries — it shells out to the user's Homebrew install.

That service orchestration is only half of it. **Agents** is a top-level section
alongside Sites: per-site AI-CLI terminals, a file explorer and git Changes pane, and an
in-app browser, so a site and the agent working on it sit side by side. The README states
the positioning as _AI-native WordPress development environment_ — when weighing a design
call, both halves count, and neither is a bolt-on to the other.

Two processes, separated by file extension:

- **Main process** — `electron/*.cjs` (CommonJS). Node access, runs all system commands.
- **Renderer** — `src/**/*.jsx` (React 19 + React Router 6 + Tailwind, built by Vite).

⚠️ **Only the renderer hot-reloads.** Vite HMR picks up `src/**` instantly, but
the main process does not reload — `npm run dev` keeps running the `electron/**`
code it started with. So **restart `npm run dev` after any change under
`electron/`**, and do it as the last step of the work rather than waiting to be
asked: without it the app silently goes on executing the old handlers, and
whoever is testing is testing something other than what was just written. The
symptom is a change that "didn't do anything" — a new `ipcMain.handle` that
isn't registered, a service function still on its previous behaviour.

The two communicate **only** through the contextBridge in `electron/preload.cjs`, which
exposes `window.electronAPI`. There is no `nodeIntegration`; the renderer cannot touch
Node directly. When adding a feature that crosses the boundary you must touch three places:

1. `electron/ipc.cjs` — register an `ipcMain.handle(...)` handler.
2. `electron/preload.cjs` — expose a wrapper method (and whitelist any new event channel
   in the `validChannels` arrays for `on`/`off`).
3. `src/components/*.jsx` — call `window.electronAPI.<method>()`.

### Main process layout

- `main.cjs` — app lifecycle, single-instance lock, window. Note the app is dock-hidden
  by default; closing the window hides to tray (doesn't quit). `before-quit` removes the
  close listener so the app can actually exit.
- `ipc.cjs` — all IPC handlers; also owns `getServiceStatus()` and `startStatusPoller()`
  which pushes `service-status-update` events to the renderer on an interval.
- `services/procman.cjs` — child-process supervisor. nginx, PHP-FPM, MySQL, and
  Mailpit run as supervised **children of the app** (spawned from spec objects each
  service module builds), NOT via `brew services` — this keeps them out of macOS
  "App Background Activity". Crash restart with backoff, graceful-stop escalation,
  pid-file orphan reconciliation after a hard app crash. Services stop on quit and
  auto-start on launch (`main.cjs`). Only dnsmasq still uses `brew services` (root
  LaunchDaemon, port 53). `services/migration.cjs` unregisters the old brew services
  once per machine.
- `store.cjs` — `JsonStore`, a dependency-free JSON persistence layer at
  `userData/wpxen-data.json`. Supports dotted key paths (`get('a.b', default)`).
  Sites and settings live here.
- `tray.cjs` — menu-bar icon and context menu.
- `services/` — one module per concern, most wrapping CLI calls via `execSync`:
  - **Stack** — `brew.cjs` detects the Homebrew prefix (`/opt/homebrew` on Apple
    Silicon, `/usr/local` on Intel) and discovers/switches installed PHP
    versions; most other modules derive their config paths from
    `brew.getBrewPrefix()`. `nginx.cjs` generates per-site vhosts in
    `{prefix}/etc/nginx/servers/<domain>.conf`. Plus `php.cjs`, `mysql.cjs`,
    `dnsmasq.cjs`, `wordpress.cjs` (WP-CLI install flow), `logs.cjs`,
    `setup.cjs`.
  - **Site lifecycle** — `siteops.cjs` is the shared engine behind Export,
    Import, Clone and Blueprints; every entry point streams `{step, message}`
    progress like `createWordPressSite` does, and long WP-CLI calls run through
    `wpAsync` on a 10-minute budget. `archive.cjs` / `wpress.cjs` handle the
    archive formats; `blueprints.cjs` stores full site snapshots at
    `userData/blueprints/{id}.zip` and creating from one is just an import.
  - **Extras** — `mailpit.cjs` (SMTP sink + web inbox on :8025; routes PHP
    `mail()` in via a `sendmail_path` override written into every installed PHP
    version's conf.d, and wraps Mailpit's REST API for the in-app Mail page),
    `phpmyadmin.cjs` (serves phpmyadmin.test, auto-logs-in with the stored
    credentials), `mkcert.cjs` (locally-trusted CA for per-site HTTPS),
    `cloudflared.cjs` (public tunnels).
  - **Privilege** — `admin.cjs` builds the osascript "with administrator
    privileges" command; its prompt text is customizable, but the bold app name
    in the macOS dialog is not, without shipping a signed privileged helper.
    `sudoers.cjs` installs `/etc/sudoers.d/wpxen`.
  - **Support** — `settings.cjs` (see below), `agents.cjs` (see below),
    `browser.cjs` / `browserHistory.cjs` / `safeUrl.cjs` (see below),
    `externalTools.cjs` (which app opens a file/folder/terminal — maps each
    editor to its `$PATH` CLI shim, falling back to `shell.openPath`),
    `files.cjs`, `git.cjs`, `validation.cjs`, `errors.cjs`, `asyncExec.cjs`.
  - **Office** — `office/` (see below): `engine.cjs` (poll loop) drives
    `scanner.cjs` / `antigravity.cjs` / `tailer.cjs` / `projectKey.cjs` into the
    pure `reducer.cjs` (typedefs in `types.cjs`); `hooksInstaller.cjs`,
    `forwarder.cjs` and `hookSocket.cjs` are the optional Claude Code hook.

### Settings

`services/settings.cjs` is the single source of truth: every preference is
declared once in the `SETTINGS` schema with its type (`bool | string | int |
float | enum | path | list | object`), default and bounds. The renderer never
writes the store directly — it sends a patch to `settings-set`, validated
there, so a malformed or unknown key can never reach disk. Side effects (login
item, MySQL credentials, nginx reloads) hang off an `effects` map injected at
init, which keeps the module free of electron imports and therefore testable.
Values are addressed by dotted key and persisted under the `settings.` prefix
(`app.confirmOnQuit` → `settings.app.confirmOnQuit`).

Adding a setting means **two** places, not one: the schema in `settings.cjs`
_and_ the presentation entry in `src/lib/settingsRegistry.js` (which drives the
sections list and the search index in `settingsSearch.js`). They're parallel
lists — a schema key with no registry entry is invisible in the UI.

There is **no Save button**. `src/lib/useSettings.js` writes optimistically:
local state updates immediately so the UI never lags the pointer, then
persists, and rolls back with a reason if the main process rejects. The
provider also listens for `settings-updated`, so a change made elsewhere (the
Mail page's catch toggle, the tray) lands in an open Settings page without a
refetch.

### Agents

`services/agents.cjs` runs an AI-provider CLI in a pseudo-terminal rooted at a
site's webroot — a Site may host many Sessions, keyed by `sessionId`. The
Agents sidebar is a **Projects** list: the opt-in working set of Sites
(`agentProjects` in the store, see `services/agentProjects.cjs`) with every
Session under it, live or exited, pushed on `agent-sessions-update`. Each
Session's terminal title and status (`idle | working | done | needs-input |
exited | error`, plus `unread`) are derived from pty output by
`services/agentStatus.cjs` — OSC title glyphs (kept as data in
`TITLE_GLYPHS`), real BELs, and the shell's exit code — so background Sessions
whose xterm isn't mounted are still tracked. Unread needs to know what's on
screen: the renderer reports the selected Session (`agent-view`) and
`ipc.cjs` watches window focus. The same module's `createNotifier` gates
native notifications (settings switches, suppress-when-focused, 5 s
per-session cooldown); `agents.cjs` stays electron-free by handing approved
alerts to `onAlert`, and `ipc.cjs` / `main.cjs` deliver them as a
`Notification`, the tray count + "Agents needing attention" menu, and the dock
badge. Agent hooks can feed the engine later through its normalized
`apply({ state, source })` entry point. The pty lives in the **main process, with
no daemon** (see `docs/adr/0001-main-process-pty-no-daemon.md`), so it survives
the window hiding to the tray and is reaped on quit; reattach after a window
reopen is served from an in-memory ring buffer. The provider registry is
data-shaped: `cmd` is the binary detected on `$PATH` and spawned, `install` is
the hint shown when it isn't found, and the optional `installer` is the
one-click target, tagged by kind:

- `{ kind: 'brew', name, cask }` → `brew install [--cask] <name>`
- `{ kind: 'npm', package }` → `npm install -g <package>`
- `{ kind: 'script', url }` → the vendor's install script, https only

**Prefer `brew`, and verify the package before adding one.** `brew info` must
show it exists _and_ that its artifact is the binary `cmd` looks for — a cask
that installs an `.app` passes the name check and still leaves the agent
undetected (this is exactly how `antigravity` vs `antigravity-cli` went wrong
once). A wrong entry fails at click time, not review time.

`kind: 'script'` is the escape hatch for CLIs distributed no other way, and it
is a real step up in trust: it downloads and executes vendor code. Guardrails
that must stay — https-only with no embedded credentials (`installScriptUrl`),
fetch-then-run rather than `curl | bash` so nothing in the URL can become shell
syntax and a CDN error page can't execute halfway, and UI wording that names
the host rather than dressing it up as the same act as `brew install`. Note
these scripts commonly append a `PATH` line to the user's shell rc — that's
usually what makes detection work afterwards, so it's allowed but must be
disclosed, not silent.

`kind: 'npm'` is for CLIs published only to npm. It runs under the login-shell
environment so it uses the node the user actually has (nvm, Volta, Homebrew),
and `npmInstallArgs` guards the spec the same way brew's does — a scoped name
with an optional `@version` or tag, nothing that could pass as a flag. Its
caveat is real and belongs in the tooltip, not in a comment nobody reads: a
global install lands in the **active node version's prefix**, so switching node
makes the CLI vanish, and WPXen has no undo for it the way `brew uninstall`
gives one.

Entries with none of the three keep a text-only hint and get no button. WPXen
still never installs anything unprompted; the user clicks.

### In-app browser

The renderer owns the `<webview>` element (`src/lib/browser/webviewCache.js`);
the main process (`services/browser.cjs`) only holds the guest's
`webContentsId` and attaches what a renderer can't — window-open policy,
DevTools, native context menus, key interception.

- **Hide, don't destroy — and never move.** Each tab's `<webview>` is inserted
  into the document **once**, into a fixed layer at the end of `<body>`, and
  stays there. The pane renders a placeholder; the cache positions the webview
  over it with CSS (one rAF loop tracks the placeholder's rect) and hides it
  on unmount, so switching away and back keeps the page, scroll position, JS
  state and login. ⚠️ **Re-parenting a `<webview>` (moving it to another
  parent) reloads the guest** — verified on Electron 28 and 43 — so never
  `appendChild` it anywhere else; removing it destroys it.
- The layer is `z-index: 0`, so every menu, popover, tooltip and dialog
  (`z-50` and up) paints above a page. Something the pane draws _over_ the page
  area (the error / blank-tab overlays) must call `setCovered` so the webview
  steps aside.
- `register()` is idempotent — it tears a previous guest's listeners down
  rather than stacking a second set — and the renderer re-registers whenever
  `dom-ready` reports a different `webContentsId`.
- `PARTITION` (`persist:wpxen-browser`) is duplicated in `webviewCache.js` and
  `browser.cjs` and **must stay in sync** — the renderer sets it on the element,
  the main process is what "clear browsing data" wipes. Asserted in the tests.
- Only `http:`, `https:` and `about:` are allowed. The real enforcement point is
  the `will-navigate` / `will-redirect` guard, not `will-attach-webview` (which
  only ever sees the initial, empty src).
- `sanitizeUrl` exists in both `src/lib/browser/sanitizeUrl.js` and
  `browser.cjs` — keep the two in sync.
- `services/safeUrl.cjs` is the **only** path out of the app; everything that
  opens an external URL goes through `openExternalSafely`, which refuses
  anything but http/https. `src/lib/useOpenLink.js` is the renderer-side
  decision point for Settings → General → _Open links in_ (`system` vs `app`).

### Office

The **Office** section is a one-time port of the standalone claude-agent-verse
project (`docs/adr/0002-office-native-port.md`): every live Claude Code session on
the machine (not only WPXen's own Sessions) and every recently written Antigravity
conversation is a character at a desk in a 3D room. It only observes. The engine
under `services/office/` is electron-free and tested through `CLAUDE_HOME` /
`ANTIGRAVITY_HOME` temp dirs plus `__setDeps`.

- **Lifecycle.** Nothing is scanned before the first Office visit. The page calls
  `officeStart` (`office-start`), which starts the engine once and returns the
  current Office. From then on it stays warm until `before-quit` calls
  `engine.stop()`, and switching sections never stops it. Snapshots arrive on
  `office-update`. Each 1 s poll (a setTimeout chain) runs the Claude registry scan,
  then the Antigravity scan, then subagent discovery, then a `tick`. `agSnapshot` is
  assigned before its events dispatch because `tailAntigravity` reads the transcript
  path from it.
- ⚠️ **Same-reference contract.** `reduce(office, event)` returns the _same object_
  when nothing changed, and `dispatch` pushes a snapshot only when
  `office !== before` (then coalesces 100 ms). A branch that rebuilds the Office
  unconditionally, on `tick` above all, still passes every `toEqual` test. It also
  pushes a full snapshot every second, re-plans the floor, and keeps the shadow map
  re-rendering, because `ShadowBudget` is keyed on the Office's identity. Put new
  derivations in `computeOfficeState`, which commits a session only when a field
  flips. The tick test asserts `toBe`, so keep it.
- **`ended` linger.** `session_ended` keeps the session as `ended` (tool and interns
  cleared, tailers stopped at once). The first tick stamps `endedAt`, and the first
  tick `ENDED_LINGER_MS` later removes it. Ended sessions are skipped by the waiting
  and break derivations and ignore every event but `session_appeared` (a reused pid
  replaces it) and `tick`; the HUD counts only live ones, and focus clears on actual
  removal.
- **Snapshot sink.** `start({ onSnapshot })` binds production's sink once; `ipc.cjs`
  resolves the windows when each snapshot is sent. `__setDeps({ onSnapshot })`
  stays the test override.
- **Credentials guardrails.** `scanner.cjs` reads only `*.json` in
  `~/.claude/sessions/` and skips names containing `.key`, because the key files
  beside them are credentials. `antigravity.cjs` lists only `<root>/brain/` folder
  names and opens only `.system_generated/logs/transcript.jsonl`, because
  `~/.gemini` holds OAuth credentials. Widening either filter is a credential
  read, not a refactor.
- **The hook** makes _waiting on you_ exact. It is optional: without it, a tool
  running ≥ 15 s is read as waiting (always, for Antigravity). Settings → Office
  drives `office-hooks-install` / `-uninstall` / `-status`. Like `dns.sudoers`, it
  is an action row with a `settingsRegistry.js` entry and no schema key,
  deliberately deviating from #187's "schema and registry": there is no stored
  value, the state lives in the Claude file.
  - `hooksInstaller.cjs` edits **`~/.claude/settings.json`** (`$CLAUDE_HOME`
    overrides the dir). Claude Code and the tools coexisting there (Orca, Agent
    Flow, Superset) register their hooks in that file. The source's `~/.claude.json`
    is only swept for legacy entries. Each entry uses the file's matcher-wrapper
    shape `{ hooks: [{ type: 'command', command }] }`, because Claude Code does not
    run the source's bare `{ type, command }`. The command is
    `'<abs node>' '<userData>/wpxen-hook-forwarder.cjs' # wpxen`.
  - **The tag is the ownership record.** Install adds an entry only where none
    bears `WPXEN_HOOK_TAG`. Uninstall removes exactly the tagged ones, and
    `updateHooks` writes each key back in its original shape, so other tools' hooks
    round-trip byte-identical. An entry edited by hand without the tag is invisible
    to both, and uninstall leaves it firing forever. Both verbs also strip
    `LEGACY_HOOK_TAGS` (`# claude-agent-verse`) in the same edit. Edits are
    `office-hooks-preview` (diffs for `settings.json` and the legacy sweep, nothing
    written) then, after a confirm in Settings, `office-hooks-apply` with the
    preview's token (refused if a file changed since): `.bak` backup, `.tmp`, then
    an atomic rename.
  - Install refuses unless `node` resolves on the login-shell PATH, and pins its
    **absolute path** (Claude Code's own PATH may lack nvm/Volta). If that node or
    the forwarder is later deleted the hook silently dies: `status()` reports
    `healthy: false` with a problem code, Settings polls it (focus + 5 s) and offers
    Reinstall. Bare-`node` entries from older builds are still matched by the tag.
    The system node is used rather than `ELECTRON_RUN_AS_NODE`, because a baked app
    path goes stale when the app moves.
  - ⚠️ `forwarder.cjs` is **copied** into userData at install time. Editing it
    changes nothing on an installed machine until the hook is reinstalled. Keep it
    node-core only, and make fixes on the receiving side: `hookSocket.toHookEvent`
    maps Claude's `hook_event_name` / `session_id` onto the reducer's `type` /
    `sessionId`. The forwarder sends its `ppid` as the pid, which need not be
    Claude's own, so the reducer falls back to `sessionId`. Without that mapping,
    every hook event silently matches no session.
  - ⚠️ The forwarder runs on every tool call of every Claude session, whether or not
    WPXen is running, so it must exit 0 fast. It exits before reading stdin when the
    socket file is absent, and a 1 s `process.exit(0)` ceiling caps everything
    else. A forwarder that hangs or exits non-zero stalls or breaks Claude Code.
  - `hookSocket.cjs` listens on `<userData>/wpxen-hook.sock` only while the engine
    runs, so events from before the first Office visit are dropped. The socket is
    created under a `0o177` umask, and its 0600 mode is the only authentication.
    `forwarder.cjs` repeats the name as a literal because it can't require
    anything, and a test asserts the two match.
- **Naming law.** `WPXEN_HOOK_TAG`, `WPXEN_FORWARDER_FILENAME` and
  `LEGACY_HOOK_TAGS` sit together in `hooksInstaller.cjs`.
  `WPXEN_HOOK_SOCKET_NAME` is in `hookSocket.cjs`. The selected room persists under
  `wpxen.office.room` (`ROOM_STORAGE_KEY` in `OfficePage.jsx`).
- **Renderer.** The HUD (room tabs, agent list, inspector, badges) is WPXen chrome
  on tokens. The R3F scene in `src/components/office/scene/` keeps the source art
  direction, so the hex palette in `src/lib/office/scene/theme.js` is deliberate and
  stays untokenized. The tests cover the pure logic in `src/lib/office/` (layout,
  breaks, pacing, focus, HUD order). The scene itself is checked with the dev-only
  Preview menu, which `import.meta.env.DEV` strips from packaged builds.
  `StaticBatch` rebuilds merged furniture only when its `version` string changes,
  so a prop that changes how furniture looks must be part of `version` or the
  furniture renders stale.

### Testing

Tests live in `test/`, run under vitest, and cover main-process logic plus pure
renderer helpers.

- **There is no DOM environment** — jsdom/happy-dom are not installed. Anything
  that needs one is instead tested by extracting a pure, inspectable value: the
  CodeMirror theme spec (`editorMetricsSpec`), the xterm option map
  (`toTerminalOptions`), the history array transforms. Prefer that over adding a
  DOM dependency.
- **`vi.mock` does not reach `electron/**/*.cjs`.** These load through Node's
  CJS loader, out of its reach. Modules that need a swappable dependency
  therefore expose their own seam: a `deps` object plus a `__setDeps()` export
  (`browser.cjs`, `externalTools.cjs`). Follow that pattern rather than
  reaching for `vi.mock`.
- Keep the no-module-scope-`require('electron')` rule above in mind when a new
  test imports a main-process module; the ratchet test enforces it.
- **Chat transcript fixtures copy real record shapes, never real content.**
  `test/fixtures/*.jsonl` mirror the keys, nesting and ordering of records seen
  in real Claude / Codex / Antigravity transcripts, with invented text, paths
  and ids. Shapes drift between Agent versions, so a fixture only proves what
  it was copied from. `test/real-transcripts.test.js` is the drift check: it is
  skipped unless `WPXEN_REAL_TRANSCRIPTS=1`, then runs every decoder through
  the watch engine (first page, then Load older to the top) over
  `~/.claude/projects`, `~/.codex/sessions` and
  `~/.gemini/antigravity-cli/brain`, and asserts invariants — every row has a
  unique id, no tool result renders as a user row, unpaired calls stay under a
  threshold, nothing over the IPC cap, Load older never stalls. It prints counts
  only. Run it after touching a decoder or `agentChat.cjs`:
  `WPXEN_REAL_TRANSCRIPTS=1 npx vitest run test/real-transcripts.test.js`.

### Renderer layout

`src/components/` is flat except where a feature owns several files:
`settings/` (`SettingsLayout`, `SettingsSidebar`, shared `controls.jsx`, and one
file per section under `sections/`), `browser/` (`BrowserPane`,
`BrowserToolbar`, `BrowserErrorOverlay`) and `office/` (`OfficePage`, the HUD, and
the R3F scene under `scene/`). `src/lib/` holds the non-React logic:
`theme.js` / `editorTheme.js` / `typography.js` for appearance,
`settingsRegistry.js` + `settingsSearch.js` for the settings index,
`browser/` and `terminal/` for the two imperative surfaces, and `office/` for the
Office's pure derivations.

### Renderer UI conventions

The UI follows the Superset design system (see `reference/superset-main`): an
opaque, flat, hairline-bordered surface set on a warm near-black "ember" dark
theme / neutral light theme. Pages compose the shared primitives in
`src/components/ui.jsx` (`Button`, `Card`, `Row`, `SectionLabel`, `IconTile`,
`Toggle`, `SegmentedTabs`, `PageHeader`) plus the `.settings-card` /
`.settings-row` / `.btn-*` / `.form-input` / `.panel` classes in
`src/index.css` — don't hand-roll cards, rows, or buttons. Page content wraps
in `px-6 pb-6 max-w-[735px] mx-auto`.

**Semantic tokens.** Every theme-dependent color resolves through a CSS
variable in `src/index.css`, exposed to Tailwind in `tailwind.config.js` as
`rgb(var(--x) / <alpha-value>)`. Use these, not literal colors:

| Token                          | Use                                                                 |
| ------------------------------ | ------------------------------------------------------------------- |
| `background` / `foreground`    | page surface + primary text                                         |
| `card`, `popover`              | raised surfaces, menus, dialogs                                     |
| `muted` / `muted-foreground`   | subtle fills, secondary text                                        |
| `accent`                       | **neutral hover fill** — not the brand color                        |
| `tertiary` (+ `-active`)       | pane toolbars, wells                                                |
| `primary`                      | monochrome primary buttons                                          |
| `border`, `input`, `ring`      | hairlines, field borders, focus rings                               |
| `sidebar*`                     | sidebar surface / hover / border                                    |
| `highlight`                    | **the brand blue** — cursor, selection, active pill, toggles, links |
| `destructive`                  | danger text/fills                                                   |
| `status-running/warning/error` | `#10b981` / `#f59e0b` / `#ef4444`                                   |

⚠️ `accent` means _gray hover fill_, `highlight` means _blue_. Getting these
backwards is silent — it just renders the wrong color.

Radius scale is driven by `--radius: 10px`: `rounded-sm` 6px, `md` 8px, `lg`
10px, `xl` 14px. The old `gray-*` / `surface-*` / `wp-*` palettes are **gone**
— those utilities no longer compile; use the semantic tokens.

**Buttons.** All shape/size lives in the base `.btn` class (`src/index.css`):
`rounded-md`, `h-8`, `text-[13px]`, `px-3`, `gap-1.5` for icon+label spacing.
Variants (`.btn-primary/secondary/danger/ghost`) add color only; the `Button`
component in `ui.jsx` maps `variant` → class. `primary` is deliberately
**monochrome** (near-white on dark, near-black on light) — blue is an accent,
not a button fill. Icons are `size={13–14}`; never add `mr-*` to a button icon
(it doubles the base gap) and never re-set `text-xs`/`text-sm` at call sites.
New button styles = new variant + `.btn-*` rule, not inline styling.

**Surfaces.** The window is opaque (`backgroundColor` in `main.cjs`, mirrored
onto `nativeTheme` changes) — there is no vibrancy, translucency, or
backdrop-filter anywhere. Cards are `bg-card border border-border rounded-xl
shadow-sm`; menus and dialogs use `.panel` / `.panel-menu` on the `popover`
surface; wells use `.sheet-well` on `tertiary`. Pane chrome (editor tab strips,
agent toolbars) sits on `tertiary` with the content on `background`.

**Icons.** lucide-react, monochrome, colored only by text color
(`text-muted-foreground` → `hover:text-foreground`). The one deliberate
exception is `IconTile` / `TILE_COLORS` — the colored rounded-square tiles in
the sidebar, page heroes and settings rows are part of WPXen's identity and
stay.

**Terminal & editor.** Both derive their palettes from `src/lib/theme.js`
(`terminalThemes`, `uiColors`, `MONO_STACK`) rather than hardcoding hex —
`src/lib/editorTheme.js` maps the ANSI set onto CodeMirror highlight tags the
way Superset's `editor-theme.ts` does. Terminal and log panes sit on
`bg-background`, not in a separate dark box, and flip with the system
appearance via `onThemeChange`.

**Dark mode.** Light/dark follows the macOS system appearance — there is no
in-app switcher.

- `nativeTheme` stays on its default `'system'` source, so the renderer's
  `prefers-color-scheme` tracks macOS, which Tailwind consumes via
  `darkMode: 'media'`. `main.cjs` listens for `nativeTheme` `updated` only to
  keep the opaque window backdrop in sync.
- Because the tokens flip themselves, **`dark:` variants are almost never
  needed** — the whole app has one (`dark:bg-input/60` on the active segmented
  tab). If you're reaching for a `dark:` variant, you're probably using a
  literal color where a token belongs: `bg-red-50 dark:bg-red-500/10` should
  just be `bg-destructive/10`.

### Key implementation notes

- Service modules run real `brew services` / `pgrep` / `mysql` / `wp` commands against
  the user's machine — changes here have real side effects (start daemons, write configs,
  create databases). Be deliberate when editing them.
- Adding a site is a multi-step pipeline in `wordpress.cjs`/`ipc.cjs` that streams
  progress via the `site-create-progress` channel (download WP → create DB → wp-config →
  install → write nginx vhost → reload nginx).
- `dnsmasq` setup writes `/etc/resolver/test`, which requires sudo — it triggers a macOS
  admin password dialog. This is intentionally a one-click action from Settings.
- **Homebrew 6 tap trust.** Homebrew 6.0 enables `HOMEBREW_REQUIRE_TAP_TRUST` by
  default and refuses formulae from untrusted taps. EOL PHP versions (8.0, 7.4)
  come from the `shivammathur/php` tap, so `php.cjs` runs `ensurePhpTapTrusted()`
  (`brew tap` + `brew trust`, both idempotent, errors swallowed for pre-6.0 brew)
  before installing/upgrading a `TAP_PHP_VERSIONS` entry. Also note brew prints a
  multi-line "taps are not trusted" _warning_ about any unrelated untrusted taps
  on the machine — `runBrewStreaming` therefore extracts the real `Error:` line
  for rejections instead of the raw output tail.

- **Never `require('electron')` at module scope** in anything a test imports —
  see the CI note at the top. This fails only on the runner.

### Legacy names (WPHerd, WPDevPilot)

The app has been renamed twice — **WPHerd** → **WPDevPilot** → **WPXen** — and
each name was written into places outside the app bundle. Every compatibility
path therefore carries _two_ older generations, not one, and they're ordered
newest-first so a user who skipped a release is handled the same as one who
upgraded through every name. These shims are deliberate — don't tidy them away:

- `services/rebrand.cjs` walks `LEGACY_GENERATIONS` (`WPDevPilot`, then
  `WPHerd`) and copies the first `*-data.json` it finds, plus `blueprints/`,
  out of that `Application Support` directory on first launch. Renaming moved
  `userData` (Electron derives it from `productName`), so without this an
  upgrading user's sites and settings look deleted. It copies rather than
  moves, and never overwrites data the renamed app already has.
- `siteops.cjs` imports archives carrying any historical manifest name
  (`MANIFEST_NAMES`) or `format` tag (`MANIFEST_FORMATS`); it only ever
  _writes_ the current names.
- conf.d is read alphabetically and `zz-wpxen.ini` sorts after both
  `zz-wpdevpilot.ini` and `zz-wpherd.ini`, so ours now wins on load — but a
  leftover still has to be cleared or it lingers forever setting directives
  nothing owns. `php.cjs` reads the newest old file once for its customised
  values, then deletes every generation on the next write. `mailpit.cjs` clears
  all of them on every `setCatchEnabled` call, enabled or disabled — turning
  catching off deletes only our own file, so a leftover override would keep
  piping `mail()` into Mailpit with the toggle reading off.
- `wordpress.cjs` deletes every legacy-prefixed mu-plugin when writing its own
  (`LEGACY_PREFIXES`) — multiple copies redeclare the same PHP functions and
  fatal the site, and an old magic-login plugin would keep honouring a stale
  secret.
- `sudoers.cjs` removes every `LEGACY_SUDOERS_PATHS` entry inside the same
  privileged step that installs (or removes) `/etc/sudoers.d/wpxen`. They are
  live `NOPASSWD` grants, so leaving one behind is a real permission the app no
  longer knows about.

Not carried over, deliberately: the browser partition
(`persist:wpxen-browser`) and the `wpxen.*` localStorage keys start fresh, and
nginx vhosts keep whatever header comment they were written with — it's
cosmetic and rewritten on the next vhost regeneration.

**Adding anything new that carries the name.** Any file, option, PHP function,
query param or path the app writes _outside its own bundle_ becomes another
thing a future rename has to migrate. Use the current `wpxen` prefix, and put
it somewhere a rename can find: a named constant near the top of its module,
next to the `LEGACY_*` list it will one day join. Two failure modes are worth
knowing, because both are silent — an orphaned file that keeps applying
settings nothing owns any more (php.ini fragments, sudoers grants), and a
duplicate that actively breaks (two mu-plugins redeclaring the same PHP
function fatals the site).

## Further reading

- `README.md` — service flow, DNS setup, Homebrew path details.
- `CONTEXT.md` — product framing and open questions.
- `docs/adr/` — architecture decisions, with the reasoning that led to them
  (e.g. `0001-main-process-pty-no-daemon.md`).
- `docs/features/` — per-feature notes.
- `plans/` — the implementation plans behind the Superset parity work (UI
  redesign, terminal, file explorer, browser, global settings). Useful for
  intent; they describe what _was_ planned, so treat the code as authoritative
  where the two disagree.
- `reference/superset-main` — the vendored Superset app the design system is
  drawn from. Untracked and eslint-ignored; it is a reference, not a dependency.
