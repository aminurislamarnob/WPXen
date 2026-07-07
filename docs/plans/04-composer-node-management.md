# Development Plan — Composer & Node Management

**Roadmap:** Tier 2 #11 (`docs/features/FEATURES.md`) · _Provided by: Herd_
**References:** [Herd docs](https://herd.laravel.com/docs) · [Herd — databases & services](https://herd.laravel.com/docs/macos/getting-started/databases)

## Overview & goals

Herd-style runtime management: detect/install **Composer** and multiple **Node.js
versions** through Homebrew, switch the globally linked Node, pin a Node version
per site, and run Composer/npm tasks in a site's directory with streamed output.

**Decision: brew keg-only `node@X` formulae, not nvm.** nvm is a shell function
(unusable from `execSync` without sourcing profiles) and lives outside the
`brew.getBrewPrefix()` world every service module is built on. Brew's
`node` (current) + `node@20`/`node@22` (LTS kegs) give the same capability with the
exact discover/install/switch machinery `php.cjs` already implements.

## Architecture & approach

Two new service modules mirroring `php.cjs`'s shape, one new "Runtimes" page cloning
`PHPVersions.jsx`, and a per-site pin consumed by PATH injection.

- **Composer** is a single formula (no versions) — detect / install / update / show
  version, plus a per-site command runner.
- **Node** is multi-version: `NODE_VERSIONS = ['24','22','20','18']`-style list
  (current + supported LTS kegs; keep it a constant like `CORE_PHP_VERSIONS`).
  "Active" = the brew-linked one (`brew unlink node@* && brew link --overwrite
  --force node@X`, same as `switchActivePhpVersion`).
- **Per-site pinning** doesn't relink globally; it resolves the keg's bin dir
  (`<prefix>/opt/node@X/bin`) and prepends it to `PATH` wherever WPHerd spawns
  processes for that site: the "Open in Terminal" action and the in-app task runner.

## Main-process work

1. **`electron/services/composer.cjs`** (new):
   - `isInstalled()` / `getVersion()` (`composer --version` via the brew prefix or
     PATH), `install(onProgress)` + `update(onProgress)` via
     `php.runBrewStreaming(['install'|'upgrade','composer'])`.
   - `run(site, args, onProgress)` — spawn `composer <args>` with `cwd: site.path`,
     env containing the site's PHP version bin first in PATH
     (`php.getPhpBinPath(site.phpVersion)` dir) so `composer install` uses the
     site's PHP; stream stdout/stderr lines to `onProgress`. Whitelist the arg
     verbs exposed over IPC (`install`, `update`, `dump-autoload`, `require` …) —
     array-argv, no shell (same injection posture as `wordpress.wp`).
2. **`electron/services/node.cjs`** (new), mirroring `php.cjs`:
   - `NODE_VERSIONS`, `installFormulaFor(version)` (`node@X`, plain `node` for
     current), `getInstalledVersions()` (scan `<prefix>/opt/node*`),
     `getActiveVersion()` (`node --version` through brew bin),
     `installVersion(version, onProgress)` (reuse `php.runBrewStreaming`),
     `switchActiveVersion(version)` (unlink/link), `getBinDirFor(version)`.
   - `getSiteEnv(site)` — returns `{ PATH: <pinned-node-bin>:<composer/php bins>:$PATH }`
     for site-scoped spawns; used by the terminal action and `composer.run`/npm runner.
   - Optional `runNpm(site, args, onProgress)` — same runner shape for
     `npm install` / `npm run <script>` (scripts listed from the site's
     `package.json` if present).
3. **`ipc.cjs` wiring:** extend the "Open in Terminal" handler to build its command
   environment through `node.getSiteEnv(site)` so a pinned site opens with the right
   `node`/`npm` on PATH.
4. **Dependency checks:** add Composer/Node rows to the existing `deps` payload used by
   Onboarding/Settings (optional, informational — neither is required for core WPHerd).

## IPC / preload

- Handlers: `get-runtimes-status` (composer version + node installed/active lists),
  `install-composer`, `update-composer`, `install-node-version`,
  `switch-node-version`, `set-site-node-version`, `run-composer-task`,
  `run-npm-task`.
- Progress channels (add to `VALID_EVENT_CHANNELS` in `preload.cjs`):
  `runtime-install-progress` (brew streams), `site-task-progress` (composer/npm
  output, payload `{siteId, line}` so one listener filters like `PHPVersions.jsx`'s
  `busyRef` pattern).

## Renderer work

- **New "Runtimes" page** `src/components/Runtimes.jsx` — near-clone of
  `PHPVersions.jsx`: a Composer card (version + Install/Update button with inline
  streamed `logLine`) and a Node section with `VersionRow` (active badge,
  Set Active / Update) + `InstallRow` (Install with streamed line). Register in
  `App.jsx` routes, `Layout.jsx` `NAV_GROUPS` + `PAGE_TITLES`.
- **Per-site pin:** a "Node version" `<select>` (Inherit active / 24 / 22 / 20 / 18 —
  installed only) in `src/components/SitePhpSettings.jsx`'s pattern — either inside
  that panel renamed context or a small "Runtimes" row on `SiteDetail` Overview.
- **Task runner (Phase 3):** in `SiteDetail`, a "Tasks" panel — buttons for
  `composer install`, `npm install`, detected `package.json` scripts, output in the
  dark `ProgressLog`/`SiteLogs`-style terminal panel (fixed `bg-zinc-900` per the
  dark-mode convention).

## Data model

- `site.nodeVersion: '22'` (optional; absent = inherit globally linked).
- No settings keys needed; installed state read live from brew (single source of
  truth, like PHP versions).

## Testing

- Unit (vitest): `node.cjs` pure parts — formula mapping, version parsing from
  `node --version`, `getSiteEnv` PATH composition; `composer.cjs` arg whitelist
  (rejects unknown verbs / option injection).
- Manual: install node@20 + node@22, switch active, `node -v` reflects it; pin a site
  to 20, Open in Terminal shows v20; `composer install` in a site with a
  `composer.json` streams output and succeeds against the site's PHP version; EOL
  PHP (7.4) site + composer still resolves.

## Phased milestones

1. **Phase 1:** `composer.cjs` + `node.cjs` (detect/install/switch) + Runtimes page.
2. **Phase 2:** per-site Node pin + terminal PATH injection.
3. **Phase 3:** in-app task runner (composer/npm with streamed panel).

## Risks & open questions

- **Keg-only PATH confusion:** users with their own nvm/volta will see WPHerd's pin
  only inside WPHerd-spawned shells — state this in UI copy ("applies to terminals
  opened from WPHerd").
- **`node@X` deprecations:** brew drops EOL node kegs; keep `NODE_VERSIONS` a constant
  that's easy to bump, and tolerate install failures with brew's real `Error:` line
  (already handled by `runBrewStreaming`).
- **Long `npm install` runs:** use the async spawn path with generous timeouts and a
  cancel button (kill the child) — don't block the IPC handler on `execSync`.
