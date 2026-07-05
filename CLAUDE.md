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

The UI mimics macOS System Settings. Pages compose the shared primitives in
`src/components/ui.jsx` (`Button`, `Card`, `Row`, `SectionLabel`, `IconTile`,
`Toggle`, `PageHeader`) plus the `.settings-card` / `.settings-row` / `.btn-*` /
`.form-input` / `.panel` classes in `src/index.css` — don't hand-roll cards,
rows, or buttons. Page content wraps in `px-6 pb-6 max-w-[735px] mx-auto`.

**Buttons.** All shape/size lives in the base `.btn` class (`src/index.css`):
capsule (`rounded-full`), `min-h-[32px]` (matches the header back/forward
pill), `text-[12px]`, `px-3.5`, and `gap-1.5` for icon+label spacing. Variants
(`.btn-primary/secondary/danger/ghost`) add color only; the `Button` component
in `ui.jsx` maps `variant` → class. Conventions: icons are `size={12}
strokeWidth={2.5}` (`Play` also `fill="currentColor"`); never add `mr-*` to a
button icon (it doubles the base gap) and never re-set `text-xs`/`text-sm` at
call sites. New button styles = new variant + `.btn-*` rule, not inline
styling.

**Liquid Glass.** The window is transparent over an NSVisualEffectView
(`backgroundColor: '#00000000'` + `vibrancy: 'sidebar'` in `main.cjs`), macOS
26 style — one continuous glass sheet like Tahoe System Settings. The sidebar
is raw vibrancy (no background), the content pane carries a faint
`bg-surface/55` tint, `.settings-card` and `.panel` are frosted glass, and
buttons are capsules (`rounded-full`). Never paint opaque full-bleed
backgrounds (`bg-surface`, `bg-white`) over page areas — use translucent
tints (`bg-surface/55`) or the `.glass` primitive so vibrancy shows through.
Glass edge/highlight tokens are `--glass-border`, `--glass-highlight`,
`--shadow-glass` in `src/index.css`.

**Dark mode.** Light/dark follows the macOS system appearance — there is no
in-app switcher. How it works, and what to do when adding UI:

- `nativeTheme` stays on its default `'system'` source, so the renderer's
  `prefers-color-scheme` tracks macOS, which Tailwind consumes via
  `darkMode: 'media'`.
- All theme-dependent colors resolve through CSS variables defined in
  `src/index.css` and wired up in `tailwind.config.js`. The **gray scale
  inverts in dark mode** — `text-gray-900` is always "primary text",
  `bg-gray-50` always "subtle fill" — so standard gray/surface/accent
  utilities need no `dark:` variants.
- `dark:` variants ARE needed for literal colors: colored tint boxes and
  badges (use translucent tints, e.g. `bg-red-50 text-red-700
dark:bg-red-500/10 dark:text-red-400`), `hover:bg-black/5` →
  `dark:hover:bg-white/10`, and destructive hover states.
- Modals and context menus use the `.panel` class (white in light,
  `#2c2c2e` in dark), never raw `bg-white`.
- Terminal/log panels use fixed `bg-zinc-900` (+ `text-zinc-*`) so they stay
  dark in both modes — never `bg-gray-900`, which inverts to near-white.

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
