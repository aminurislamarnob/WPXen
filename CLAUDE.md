# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Vite renderer (localhost:5173) + Electron in parallel (concurrently)
npm run vite     # Renderer only
npm run electron # Electron only against an already-running renderer
npm run build    # vite build + electron-builder --mac → .dmg in release/ (arm64 + x64)
npm run pack     # Unpacked build (electron-builder --dir), no installer
npm run test     # vitest run (tests live in test/, cover electron/services logic)
npm run lint     # eslint . (lint:fix to autofix)
npm run format   # prettier --write .
```

There is no typechecker; the codebase is plain JS/JSX.

## Architecture

WPHerd is an Electron macOS menu-bar app that orchestrates Homebrew-installed services
(nginx, PHP-FPM, MySQL, dnsmasq, WP-CLI) to run local WordPress `.test` sites. It does
**not** bundle these binaries — it shells out to the user's Homebrew install.

Two processes, separated by file extension:

- **Main process** — `electron/*.cjs` (CommonJS). Node access, runs all system commands.
- **Renderer** — `src/**/*.jsx` (React 18 + React Router 6 + Tailwind, built by Vite).

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
  `userData/wpherd-data.json`. Supports dotted key paths (`get('a.b', default)`).
  Sites and settings live here.
- `tray.cjs` — menu-bar icon and context menu.
- `services/` — one module per service, each wrapping CLI calls via `execSync`:
  - `brew.cjs` — detects the Homebrew prefix (`/opt/homebrew` on Apple Silicon,
    `/usr/local` on Intel) and discovers/switches installed PHP versions. Most other
    service modules derive their config paths from `brew.getBrewPrefix()`.
  - `nginx.cjs` — generates per-site vhosts in `{prefix}/etc/nginx/servers/<domain>.conf`.
  - `php.cjs`, `mysql.cjs`, `dnsmasq.cjs`, `wordpress.cjs` (WP-CLI install flow).
  - `mailpit.cjs` — email catching: runs Mailpit (SMTP sink + web inbox on
    :8025) via `brew services` and routes PHP `mail()` into it by writing a
    `sendmail_path` override (`zz-wpherd-mailpit.ini`) into every installed
    PHP version's conf.d. Also wraps Mailpit's REST API for the in-app inbox
    (Mail page in the renderer).

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
the sidebar, page heroes and settings rows are part of WPHerd's identity and
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

For service flow, DNS setup, and Homebrew path details, see `README.md`.
