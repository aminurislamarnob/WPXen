# Development Plan — Xdebug Integration

**Roadmap:** Tier 1 #1 (`docs/features/FEATURES.md`) · _Provided by: Local, Herd, Studio_
**References:** [Local — Xdebug](https://localwp.com/help-docs/advanced/using-xdebug-within-local/) · [Studio — Xdebug](https://developer.wordpress.com/docs/developer-tools/studio/xdebug/)

## Overview & goals

Let users install Xdebug per PHP version, toggle it on/off, and pick its mode (debug /
develop / both), with a one-click path to step-debugging in VS Code or PhpStorm on port
9003. No manual `php.ini` editing.

**Head start:** a complete first implementation already exists in git history — commit
`243a987` ("feat: per-version Xdebug install + enable/mode toggle"), reverted by
`b22380b` purely to keep that PR scoped to the archive engine. Phase 1 is a restore of
that commit; later phases build on it.

## Architecture & approach

- **Install source:** the `shivammathur/extensions` tap (`shivammathur/extensions/xdebug@<php-version>`)
  — prebuilt bottles for every supported PHP version including the EOL 7.4/8.0 tap
  versions. Never pecl (compiles from source, mutates global `php.ini`).
- **Config ownership:** the formula drops its own `zend_extension` ini that *loads*
  Xdebug — never touch it. WPHerd owns a separate
  `<prefix>/etc/php/<version>/conf.d/zz-wpherd-xdebug.ini` that sorts after it and only
  sets `xdebug.mode` etc. This is the same managed-conf.d pattern as
  `mailpit.cjs`'s `zz-wpherd-mailpit.ini`.
- **Disable = `xdebug.mode = off`** (extension stays loaded but inert, near-zero
  overhead) — no unlinking, no formula-file edits.
- State round-trips through `; wpherd:enabled=` / `; wpherd:mode=` marker comments so
  the chosen mode survives a disable/enable cycle.
- Every mutation ends with `php.reloadPhpFpmIfRunning(version)` (SIGUSR2 graceful reload).

## Phase 1 — Restore the reverted implementation

Recover from `git show 243a987` (or `git revert b22380b` and resolve drift). Pieces:

1. **`electron/services/xdebug.cjs`** (181 lines, complete in history):
   - Pure helpers (vitest-covered): `renderXdebugIni({enabled, mode})`,
     `parseXdebugIni(content)`, `normalizeMode(mode)` (whitelist:
     debug/develop/coverage/profile/trace/gcstats, default `debug`).
   - `installXdebug(version, onProgress)` — `ensureXdebugTapTrusted()` (mirror of
     `php.ensurePhpTapTrusted`) then `php.runBrewStreaming(['install', ...])`.
   - `setXdebug(version, {enabled, mode})`, `getXdebugState(version)`,
     `getAllXdebugStates()`, `isXdebugInstalled(version)` (`php -m` grep),
     `getXdebugIniPath(version)`.
   - Enabled ini sets `xdebug.start_with_request = yes`, `client_host = localhost`,
     `client_port = 9003`.
2. **IPC** (`electron/ipc.cjs`): `get-xdebug-status`, `install-xdebug` (streams via the
   existing `php-install-progress` channel), `set-xdebug`. Standard
   `{success, error: humanize(err)}` convention.
3. **Preload** (`electron/preload.cjs`): 5 wrapper methods; no new event channel needed
   (`php-install-progress` is already whitelisted).
4. **UI** (`src/components/PHPVersions.jsx`): Xdebug sub-row inside `VersionRow` —
   Install button with inline streamed `logLine` when absent; `<Toggle>` + mode
   `<select>` (Debug / Develop / Debug + Develop) when installed. Reuse the existing
   `busyRef` filter pattern for the shared progress channel.
5. **Tests**: restore `test/xdebug.test.js` (renderXdebugIni matrix + marker round-trip).

## Phase 2 — Per-site Xdebug override

Global per-version toggles debug everything on that PHP version. Add a per-site layer:

- Extend the `SITE_PHP_SETTINGS` path: per-site vhosts already inject settings via
  `fastcgi_param PHP_VALUE` (`php.buildSitePhpValue` → `nginx.generateSiteConfig`).
  **Caveat:** `xdebug.mode` is changeable per-request only via the `XDEBUG_MODE` env /
  `PHP_VALUE` when the global mode isn't `off` — so per-site "off while globally on"
  works via `PHP_VALUE xdebug.mode=off`, but per-site "on while globally off" does
  **not**. Model it accordingly: global toggle = master switch; per-site setting =
  opt-out (plus optional per-site mode narrowing). Document this in the UI copy.
- Store as `site.phpSettings.xdebugMode` (fits the existing per-site override map);
  surface in `src/components/SitePhpSettings.jsx` as a select
  (Inherit / Off / Debug / Develop).

## Phase 3 — IDE onboarding & polish

- **Docs + in-app helper:** an "IDE setup" disclosure in the Xdebug row with copyable
  VS Code `launch.json` (pathMappings not needed — local paths) and PhpStorm steps
  (listen on 9003, no server mapping required). Optionally a "Create launch.json"
  button per site writing `.vscode/launch.json` into the site directory (confirm
  before overwrite).
- **Status surfacing:** show "Xdebug active" badge on `SiteDetail` Overview when the
  site's PHP version has Xdebug enabled (read via `getAllXdebugStates()` in the
  existing overview load).
- README/FEATURES.md updates (mark shipped).

## Data model

No new store keys for Phase 1 (state lives in the ini files — single source of truth,
drift-proof). Phase 2 adds `xdebugMode` inside the existing `site.phpSettings` map.

## Testing

- `test/xdebug.test.js` (restored): `renderXdebugIni` matrix (enabled/disabled × modes),
  `parseXdebugIni` round-trip, `normalizeMode` whitelist/dedupe/default.
- Phase 2: extend `buildSitePhpValue` tests for the xdebug key.
- Manual: install Xdebug on 8.4, `php -v` shows "with Xdebug"; toggle on, set a
  breakpoint in VS Code, load the site, verify break; toggle off, verify inert;
  `xdebug_info()` page shows mode.

## Risks & open questions

- **Tap availability:** `shivammathur/extensions` must publish a bottle for each new PHP
  version; install for a just-released PHP may fail — surface brew's real `Error:` line
  (already handled by `runBrewStreaming`).
- **Homebrew 6 tap trust:** handled by `ensureXdebugTapTrusted` (idempotent, swallowed
  for pre-6.0 brew) — same pattern as the PHP tap.
- **Performance:** `start_with_request=yes` slows every request while enabled. Keep the
  toggle prominent; consider `trigger` mode (browser-extension cookie) as a follow-up.
