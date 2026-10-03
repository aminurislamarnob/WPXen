# Per-site PHP — implementation plan

Each Site already has a `phpVersion`, editable in the UI. Today it does
nothing: every site is served by whichever PHP-FPM is globally active. This
plan makes the per-site version real — for web requests, for the WP-CLI calls
the app makes, and in the site's agent terminals.

## Why it doesn't work today

Two independent assumptions combine:

1. **Every version listens on the same address.** WPXen starts php-fpm with
   Homebrew's own `php-fpm.conf`, whose `www.conf` pool says
   `listen = 127.0.0.1:9000` for every version. No per-version socket ever
   exists, so `nginx.cjs` always falls back to `127.0.0.1:9000`.
2. **WPXen runs one FPM at a time.** procman has a single `php` slot;
   `getRunningFpmVersion`, `startPhpFpm`, the Services row, the status poller,
   auto-start and the ini reload all assume one.

Side effect: the PHP page reports every installed version as `running`
(`isPhpFpmRunning` ignores its version argument).

## Decisions

| Question                                | Decision                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Which FPMs run?                         | Only versions at least one site uses, plus the active version (phpMyAdmin). Reconciled, not all-installed. |
| What does the global "active PHP" mean? | CLI `php` link + default for new sites + phpMyAdmin's version. Never moves existing sites.                 |
| Per-site PHP beyond web requests?       | Yes: the app's WP-CLI calls use the site's PHP binary; agent terminals get `php@<ver>/bin` first on PATH.  |
| Delivery                                | One PR — the socket switch and the vhost migration only work together.                                     |

## Design

### 1. WPXen-owned FPM config per version — `php.cjs`

For each version WPXen writes its own FPM config (global section + one pool)
and spawns `php-fpm --nodaemonize --fpm-config <ours>`. Homebrew's
`php-fpm.conf` / `www.conf` are no longer read or edited.

- Pool listens on a unix socket: `{prefix}/var/run/wpxen/php<ver>.sock`.
  Not under `userData` — "Application Support" contains a space, which breaks
  `fastcgi_pass unix:…`. The directory name is a named constant next to the
  module's other `wpxen`-prefixed paths, per the rename guidance in CLAUDE.md.
- Config files live under `{prefix}/etc/php/<ver>/wpxen-fpm.conf`, so the
  existing "is this one ours?" process match (`…/etc/php`) keeps working and a
  rename can find them.
- `php.ini` and `conf.d` still load (they are php.ini-level, not FPM-level), so
  `zz-wpxen.ini` and the Mailpit `sendmail_path` override keep applying.
- Because nothing of ours binds `127.0.0.1:9000` any more, a user's own
  `brew services start php` no longer collides with WPXen. The conflict probe
  only needs to guard our own socket.

A pure `buildFpmConfig({ version, prefix, socketPath, … })` returns the file
text, so it is testable without touching disk.

### 2. One supervised FPM per version — procman slots `php@<ver>`

- `neededPhpVersions(sites, activeVersion, installed)` — pure: the set of
  installed versions used by any site, plus the active one.
- `reconcilePhpFpm()` starts what's needed and stops what isn't. Called on
  launch (auto-start), and after site create / import / clone / blueprint /
  delete and per-site PHP changes.
- `startPhpFpm(version)` / `stopPhpFpm(version)` address one slot each.
  `stopAllPhpFpm()` stops every `php@*` slot.
- Pid files and orphan reconcile already key off the slot name.

### 3. nginx — `nginx.cjs`

Every vhost uses `fastcgi_pass unix:<socket for site.phpVersion>`; the
`127.0.0.1:9000` fallback goes. phpMyAdmin's vhost points at the active
version's socket.

### 4. One-time migration

On launch, once: write FPM configs for needed versions, stop a legacy single
`php` slot if one is live, start the needed versions, regenerate **every**
vhost, reload nginx. Idempotent — safe to re-run; a marker in the store
records completion.

### 5. Global "active" version

`switchPhpVersion(version)` = relink CLI + make sure that version's FPM runs
(phpMyAdmin) + reconcile (the old active may no longer be needed). It never
touches sites. The rollback from PR #91 still applies: if the new version's FPM
won't start, the CLI link goes back.

New sites default to the active version (already the case in the Add Site
wizard).

### 6. Per-site PHP beyond web requests

- `wordpress.cjs`: `wp()` / `wpAsync()` take the site's PHP version and run
  WP-CLI with `{prefix}/opt/php@<ver>/bin/php` (falling back to the active
  binary for the unversioned `php` formula).
- `agents.cjs`: a site's pty gets the site's PHP `bin` prepended to `PATH`.

### 7. Status and UI

- PHP-FPM stays **one logical service** everywhere the UI already shows it
  (Services, Dashboard, tray, onboarding, activity bar). `getFpmStatus()`
  aggregates the per-version slots: `state` is the most urgent version's (a
  failed one first, naming it), and `versions` lists the ones up. Start / Stop
  / Restart act on all needed versions. _(Refined from "one row per version"
  during the build — the single row reads "Running · 8.5, 8.4" and keeps every
  existing consumer working unchanged.)_
- PHP page: `running` is per version; a note explains that the active version
  is the CLI and phpMyAdmin's, and never moves a site.
- `services.autoStart: ['php', …]` keeps its meaning — "the needed versions".
- `reloadPhpFpmIfRunning(version)` signals that version's slot.

### 8. Guards

Site create / import / clone / blueprint / set-site-php already validate the
version is installed; each now reconciles so the version's FPM is up before
the vhost is reloaded.

## Tests

Pure, no DOM:

- `buildFpmConfig` — socket path, pid/error log, pool name, no `127.0.0.1:9000`.
- `neededPhpVersions` — dedupes, includes active, drops uninstalled versions.
- vhost generation — always the site's socket.
- reconcile decisions through the `deps` seam on `php.cjs` (start/stop sets).
- migration — idempotent, regenerates every vhost.
- WP-CLI binary selection by version.

## Live verification

Two sites on different versions serving their own `X-Powered-By`; switching a
site's version; switching the global version leaves sites alone; migration
from today's single-FPM setup; agent terminal `php -v` matches the site;
`brew services start php` alongside WPXen no longer conflicts.

## Known trade-off

Downgrading WPXen after the migration leaves vhosts pointing at sockets the
older app doesn't create — sites 502 until vhosts are regenerated.
