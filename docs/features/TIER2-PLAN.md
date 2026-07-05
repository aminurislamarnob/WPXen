# Tier 2 Implementation Plan — Server/Service Depth

Scope: the "Server/service depth (Herd-style breadth)" tier from `FEATURES.md`,
**excluding #7 (Additional services) and #10 (WordPress Multisite)**, which are
deferred.

This plan covers three features:

- **#9 OpCache toggle & status** — fits the existing `php.cjs` managed-ini model directly.
- **#11 Composer / Node (nvm) management** — new detection + per-site version wiring.
- **#8 nginx ⇄ Apache hot-swap** — the big one; requires an architectural decision.

Ordering below is by ascending friction (ship #9 first, #8 last). Every feature
follows the three-point IPC contract from `CLAUDE.md`: an `ipcMain.handle` in
`electron/ipc.cjs`, a wrapper (and any event channel whitelist) in
`electron/preload.cjs`, and a renderer call in `src/components/*.jsx`.

---

## Feature #9 — OpCache toggle & status

**Goal.** Surface PHP OpCache in the app: enable/disable per PHP version, tune the
core knobs (memory, cached-file count, timestamp revalidation), and show whether
OpCache is currently active. Benchmark: Local and Herd both expose an OpCache
toggle in their PHP settings.

**Why it's low-friction.** OpCache is a Zend extension bundled with every Homebrew
PHP (`opcache.so`, auto-loaded via brew's `ext-opcache.ini`). Configuring it is
*purely* a matter of writing ini directives — exactly the pattern `php.cjs`
already implements for `zz-wpherd.ini`, and the same pattern the shipped Xdebug
feature uses for `zz-wpherd-xdebug.ini`.

### Main process — `electron/services/opcache.cjs` (new)

Mirror the managed-ini approach in `php.cjs`:

- `getOpcacheIniPath(version)` → `{prefix}/etc/php/{version}/conf.d/zz-wpherd-opcache.ini`.
- A settings schema (like `PHP_INI_SETTINGS`) covering:
  - `enable` (bool → `opcache.enable` + `opcache.enable_cli`)
  - `memory_consumption` (MB → `opcache.memory_consumption`)
  - `max_accelerated_files` (int → `opcache.max_accelerated_files`)
  - `revalidate_freq` (seconds → `opcache.revalidate_freq`)
  - `validate_timestamps` (bool → `opcache.validate_timestamps`; off = production-like)
- `readOpcacheValues(version)` / `writeOpcacheIni(version, values)` — round-trip the
  plain values via `; wpherd:<key>=` comments, identical to `readManagedValues` /
  `writeManagedIni`.
- `getOpcacheStatus(version)` — configured state from the managed ini, plus best-effort
  *effective* state by parsing `php -n -d zend_extension=opcache -i` (or reusing the
  ini chain the way `getGlobalSitePhpValues` does). **MVP shows configured values**;
  live runtime stats (hit rate, memory used, cached scripts) come from the FPM SAPI
  only and require an in-request `opcache_get_status()` — defer to a stretch goal
  (a tiny helper script `wp eval` against a running site, or an FPM status probe).
- Call the existing `php.reloadPhpFpmIfRunning(version)` (or replicate it) after every
  write so changes apply via SIGUSR2 with zero dropped requests.

### IPC / preload

- `get-opcache-status` → `{ settings, versions: [{version, values}] }`
- `set-opcache` `(version, key, value)` and `set-opcache-all` `(key, value)` — parallel
  to `setPhpIniSetting` / `setPhpIniSettingAllVersions`.
- Wrap all three in `preload.cjs` (no new event channel needed).

### Renderer

Add an **OpCache** card to `src/components/PhpSettings.jsx` (or a sibling under the
PHP settings page), reusing `Card` / `Row` / `Toggle` / `.form-input` from `ui.jsx`.
Layout mirrors the Xdebug card on the feature branch: a master `Toggle`, then the
numeric fields disabled while OpCache is off. "Apply to all versions" mirrors the
existing all-versions action.

### Tests

Pure functions only, per repo convention (`test/`): schema→directive mapping,
`; wpherd:` round-trip, and ini rendering. No brew calls in tests.

**Effort: S.** No architectural risk; slots into an established pattern.

---

## Feature #11 — Composer / Node (nvm) management

**Goal.** Detect and surface Composer, and let a site pick a Node version. Benchmark:
Herd bundles Composer and manages Node per site.

Two independent sub-features; ship Composer first (simpler).

### Composer (global tool)

- **Detect**: `brew.tryWhich('composer')` + `composer --version`. Composer is a single
  global PhAR, not per-PHP-version, so no per-version matrix.
- **Install**: `brew install composer` via `runBrewStreaming` (already used for PHP),
  streaming progress to the renderer.
- **Per-site action**: "Run Composer install/update" from a site's tools menu — shell
  `composer install` in the site's `path` using that site's `phpVersion` binary on PATH
  (`php.getPhpBinPath(site.phpVersion)`), streaming output to a log panel (reuse the
  `bg-zinc-900` terminal panel styling).

### Node (per-site version)

**Key constraint:** `nvm` is a *shell function*, not a binary — you cannot
`execSync('nvm use')`. Design around it:

- **Discover versions** by scanning `~/.nvm/versions/node/` for installed `vX.Y.Z`
  directories (each has a real `bin/node`). Also detect a brew-installed `node` and
  `fnm` if present. No dependency on sourcing a shell.
- Store a `nodeVersion` field on the site model (default: system/latest).
- **Use it** by resolving the absolute `.../vX.Y.Z/bin` and prepending it to `PATH`
  whenever WPHerd launches something for that site: the existing "open in terminal"
  action (inject a PATH shim / `.nvmrc` hint), and any Node task runner we add.
- No attempt to *install* Node versions in the MVP — we detect and select what nvm/fnm
  already provide, and link out to nvm if none found.

### IPC / preload

- `get-composer-status`, `install-composer` (streams via a `composer-install-progress`
  channel — whitelist it in `preload.cjs`), `run-composer(site, cmd)`.
- `get-node-versions`, `set-site-node-version(domain, version)`.

### Renderer

- A **Dev Tools** section (Settings, or per-site under site detail): Composer
  status/install row; per-site Node version `<select>` populated from
  `get-node-versions`.

### Tests

Pure helpers: nvm-directory parsing (`~/.nvm/versions/node/` → sorted semver list),
Composer version-string parsing. Filesystem scans mocked.

**Effort: M.** The nvm-is-not-a-binary constraint is the only real gotcha; document
it in the module header.

---

## Feature #8 — nginx ⇄ Apache hot-swap

**Goal.** Support Apache as an alternative webserver. Benchmark: Local lets you switch
a site's webserver between nginx and Apache.

**This is the architecturally significant item and needs a decision before coding.**

### The core problem: port contention

nginx and Apache both want to bind `:80` / `:443`. WPHerd runs nginx as a single
supervised child serving *all* sites (`nginx.buildSpec()` + per-site vhosts in
`servers/`). Two webservers cannot hold port 80 at once, so "per-site" hot-swap is
not as simple as a per-site flag. Two viable designs:

**Chosen: Option B — per-site coexistence (shipped).**
nginx stays the front door on `:80/:443`; Apache (httpd) runs as a supervised child on
loopback `:8080` and serves only the sites flagged `webserver: 'apache'`, which nginx
reverse-proxies to it. TLS terminates at nginx, so Apache only ever listens plain HTTP
internally — no second cert path. Each site carries a `webserver` field (default
`'nginx'`).

(The alternative — a single global nginx/apache toggle — was rejected in favour of true
per-site mixing.)

### Main process — `electron/services/apache.cjs` (new)

- **Detect/install** Apache: `apache.installApache` → `brew install httpd`; resolve
  `{prefix}/bin/httpd`.
- **Supervised child**: `apache.buildSpec()` for `procman` (`httpd -D FOREGROUND -f
  <generated wpherd-httpd.conf>`), parallel to `nginx.buildSpec()`. Runs *alongside*
  nginx (different port — no mutual exclusion); started only when ≥1 site is
  Apache-flagged, stopped when none remain (`main.cjs` auto-start + `set-site-webserver`
  / `remove-site` lifecycle).
- **Self-contained httpd.conf** (`generateHttpdConf`): `Listen 127.0.0.1:8080`, a
  minimal shared-module set (existence-guarded `LoadModule`, incl. `mod_proxy_fcgi`),
  default-deny, and `IncludeOptional .../wpherd-servers/*.conf`. Runs as the invoking
  non-root user (no `User`/`Group`).
- **PHP handoff**: `mod_proxy_fcgi` `SetHandler "proxy:fcgi://127.0.0.1:9000"` (or the
  per-version unix socket from `brew.getPhpFpmSocketPath`) — the *same* php-fpm the
  nginx path uses, no `mod_php`.
- **Per-site vhost** (`generateApacheVhost`): `DocumentRoot`, `FallbackResource
  /index.php` (the Apache analog of nginx's `try_files … /index.php?$args`),
  `LimitRequestBody` sized from the effective upload limit like nginx's
  `client_max_body_size`, and `SetEnvIf X-Forwarded-Proto https HTTPS=on` so `is_ssl()`
  survives the proxy. Same domain/path safety guards as nginx.
- **Known limitation (documented in the module header):** per-site PHP overrides ride
  nginx's `fastcgi_param PHP_VALUE`; over `mod_proxy_fcgi` that channel isn't available,
  so an Apache-flagged site falls back to its PHP version's global managed ini. True
  per-site overrides under Apache would need per-site FPM pools — a follow-up.

### nginx side — `nginx.generateSiteConfig`

When `site.webserver === 'apache'`, the `.php` fastcgi block is replaced by a
`location / { proxy_pass http://127.0.0.1:8080; … X-Forwarded-Proto $scheme; }`. The
http/https server-block wrappers (TLS + http→https redirect) are unchanged.

### IPC / preload / renderer

- `set-site-webserver(id, name)` (writes/removes the Apache vhost, brings httpd up or
  reloads/stops it, rewrites the nginx vhost, reloads nginx), `install-apache` (streamed
  via `apache-install-progress`), `get-apache-status`.
- Renderer: a **Webserver** segmented control (nginx/Apache) in the per-site **Dev
  Tools** tab, with an install prompt when httpd is missing.

### Tests (`test/apache.test.js`)

Pure vhost/conf generation: Apache vhost (root, proxy fcgi handler, fallback, HTTPS
restore, LimitRequestBody, safety guards), httpd.conf (loopback listen, servers-dir
include, default-deny), and nginx proxy-mode vs fastcgi-mode branching.

**Effort: L–XL** — the largest item; shipped last.

---

## Suggested sequencing

1. **#9 OpCache** — small, self-contained, immediate parity win. Ships independently.
2. **#11 Composer/Node** — Composer sub-feature first, then Node detection.
3. **#8 Apache** — last, and only after confirming Option A (global toggle) vs Option
   B (per-site coexistence).

Each feature is independently shippable and testable; none blocks the others.
