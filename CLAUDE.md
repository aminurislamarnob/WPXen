# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Vite renderer (localhost:5173) + Electron in parallel (concurrently)
npm run vite     # Renderer only
npm run electron # Electron only against an already-running renderer
npm run build    # vite build + electron-builder --mac → .dmg in release/ (arm64 + x64)
npm run pack     # Unpacked build (electron-builder --dir), no installer
```

There is no test suite, linter, or typechecker configured. The codebase is plain JS/JSX.

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

### Key implementation notes

- Service modules run real `brew services` / `pgrep` / `mysql` / `wp` commands against
  the user's machine — changes here have real side effects (start daemons, write configs,
  create databases). Be deliberate when editing them.
- Adding a site is a multi-step pipeline in `wordpress.cjs`/`ipc.cjs` that streams
  progress via the `site-create-progress` channel (download WP → create DB → wp-config →
  install → write nginx vhost → reload nginx).
- `dnsmasq` setup writes `/etc/resolver/test`, which requires sudo — it triggers a macOS
  admin password dialog. This is intentionally a one-click action from Settings.

For service flow, DNS setup, and Homebrew path details, see `README.md`.
