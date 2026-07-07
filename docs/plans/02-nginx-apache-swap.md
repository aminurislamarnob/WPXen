# Development Plan — nginx ⇄ Apache Swap

**Roadmap:** Tier 2 #8 (`docs/features/FEATURES.md`) · _Provided by: Local_
**Reference:** [Local — features](https://localwp.com/features/)

## Overview & goals

Let a site run under Apache (Homebrew `httpd`) instead of nginx, switchable after
creation and selectable at creation time. Goal parity with Local: users test `.htaccess`
rules, mod_rewrite plugins, and production-Apache behavior locally.

**Recommended model (decision):** both servers cannot bind :80/:443 simultaneously.
Adopt **one-active-web-server-at-a-time**: a global "Web server" setting (nginx default)
plus per-site `webServer` preference. When any running site needs Apache, WPHerd runs
Apache; sites are grouped per server and only the active server binds 80/443 — matching
Local's swap behavior where switching restarts the stack. Simplest correct v1: the
**global** setting drives which server runs; per-site override is a Phase 3 stretch
(requires routing, e.g. active server reverse-proxying to the other on alt ports —
explicitly out of scope for v1).

## Architecture & approach

Mirror `nginx.cjs` with a new `electron/services/apache.cjs`, then insert a thin
dispatch facade so site pipelines are server-agnostic.

- **Binary/config:** brew formula `httpd`. Config root `<prefix>/etc/httpd/`; WPHerd
  vhosts in `<prefix>/etc/httpd/wpherd-vhosts/<domain>.conf` with an
  `IncludeOptional .../wpherd-vhosts/*.conf` line injected into `httpd.conf` (same
  ensure-include pattern as `nginx.ensureServersDir`). Also ensure `Listen 80`,
  `mod_proxy` / `mod_proxy_fcgi` / `mod_rewrite` / `mod_ssl` LoadModule lines are
  uncommented (idempotent config patching, with a `; wpherd`-style marker comment).
- **PHP:** same PHP-FPM upstream as nginx — `SetHandler "proxy:unix:<socket>|fcgi://localhost"`
  (or `fcgi://127.0.0.1:9000` fallback), reusing `brew.getPhpFpmSocketPath(version)`.
  No mod_php.
- **Supervised child:** procman spec `{ name: 'apache', bin: <prefix>/bin/httpd, args:
  ['-D','FOREGROUND'], stopSignal: 'SIGWINCH' (graceful-stop), ... }` with
  `conflictProbe`/`takeover` sweeping brew-services or orphaned `httpd` processes on
  :80/:443 — same shape as `nginx.buildSpec()` including `preSpawn`/`onForceKilled`
  worker sweeps.
- **Reload:** `procman.signal('apache','SIGUSR1')` (graceful restart) when supervised,
  else `apachectl -k graceful`; pre-flight with `apachectl configtest` (parallel to
  `nginx.validateConfig`).

## Main-process work

1. **`electron/services/apache.cjs`** (new), exporting the same surface as `nginx.cjs`:
   `isInstalled`, `install(onProgress)` (via `php.runBrewStreaming(['install','httpd'])`),
   `buildSpec`, `start/stop/restart/reload`, `validateConfig`,
   `generateSiteConfig(site)` (pure, testable), `createSiteConfig`, `removeSiteConfig`,
   `siteConfigExists`, `getVhostsDir`.
   - `generateSiteConfig` mirrors nginx's: same input sanitization (reject `;{}`/
     newlines), `<VirtualHost *:80>` (+ `*:443` with `SSLEngine on`,
     `SSLCertificateFile`/`KeyFile` from `site.certPath/keyPath`, and an 80→443
     `Redirect` vhost when `site.https`), `ServerName`/`ServerAlias` (aliases),
     `DocumentRoot`, `AllowOverride All` (so `.htaccess` works — the point of the
     feature), `LimitRequestBody` from the upload setting, and per-site PHP overrides
     via `<Proxy fcgi://...>ProxySet</Proxy>` + `SetEnv PHP_VALUE` — note Apache/FPM
     passes `PHP_VALUE` as an env var (newline-joined works via
     `ProxyFCGISetEnvIf`/`SetEnvIf`); reuse `php.buildSitePhpValue(site.phpSettings)`.
2. **`electron/services/webserver.cjs`** (new facade): `active()` (reads
   `settings.webServer`, default `'nginx'`), and dispatched
   `createSiteConfig(site)` / `removeSiteConfig(domain)` / `reload()` /
   `validateConfig()`. **Replace direct `nginx.*` calls** in `wordpress.cjs`
   (pipeline steps 7–8), `siteops.cjs` (import/clone/changeUrl vhost writes), and
   `ipc.cjs` with the facade. During a server switch, write all vhosts for the target
   server before removing the old ones.
3. **Switch operation** `webserver.switchTo(server, onProgress)`:
   stop old server → ensure new installed + config patched → regenerate every site's
   vhost for the new server → configtest → start new server → remove old server's
   WPHerd vhosts. Rollback to the old server on configtest/start failure.
4. **Status:** add `apache` to `computeServiceStatus()`'s `Promise.all` +
   `serviceStatusCache` in `ipc.cjs`; only the active server is expected-running
   (auto-start logic in `main.cjs` consults `settings.webServer`).

## IPC / preload

- Handlers: `get-web-server` , `set-web-server` (runs `switchTo`, streams
  `webserver-switch-progress`), `install-apache` (streams `apache-install-progress`).
- Preload: wrapper methods + add both new channels to `VALID_EVENT_CHANNELS`.

## Renderer work

- **`Settings.jsx`:** new "Web server" section — segmented choice (nginx / Apache) with
  an install-on-demand card for Apache (copy `Mail.jsx`'s `InstallCard` pattern) and a
  `<ProgressLog>` during switch.
- **`Services.jsx`:** show the active web server row (start/stop/restart) — the
  inactive one hidden or shown "inactive".
- **`SiteDetail.jsx` Overview:** info row "Web server: nginx/Apache" (from global
  setting in v1). Phase 3 adds the per-site select.

## Data model

- `settings.webServer: 'nginx' | 'apache'` (default `'nginx'`).
- Phase 3: `site.webServer` override.

## Testing

- Unit (vitest, `test/apache.test.js`): `generateSiteConfig` matrix — HTTP/HTTPS,
  aliases, per-site PHP values, sanitization rejections — parallel to existing nginx
  config tests; config-patch idempotency (LoadModule/Include injection).
- Manual: install Apache from Settings, switch, verify site loads, `.htaccess` rewrite
  honored, HTTPS site serves the mkcert cert, permalinks work, switch back to nginx
  cleanly; kill -9 the app and relaunch to confirm procman orphan reconciliation
  adopts/clears `httpd`.

## Phased milestones

1. **Phase 1:** `apache.cjs` (install, spec, config gen) + unit tests — no wiring.
2. **Phase 2:** `webserver.cjs` facade refactor + switch flow + IPC + Settings UI.
   Global-only swap ships here.
3. **Phase 3 (stretch):** per-site server override with proxy routing.

## Risks & open questions

- **`httpd.conf` patching** is the riskiest part (user may have edited it). Keep patches
  minimal, marker-commented, idempotent, and back the file up before first patch.
- **`.htaccess` vs nginx:** WP sites created under nginx have no `.htaccess`; on switch,
  Apache + `AllowOverride All` + WP writing its own `.htaccess` on permalink save
  usually self-heals — document "re-save permalinks after switching".
- **Port conflicts:** takeover probes must handle a user's pre-existing brew `httpd`
  LaunchAgent (same migration approach as `services/migration.cjs`).
