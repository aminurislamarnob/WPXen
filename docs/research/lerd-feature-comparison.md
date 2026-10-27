# Lerd vs WPXen — feature comparison

Research date: 2026-10-27. Read-only investigation; nothing under `referances/`
was modified or executed, and no WPXen service code was run.

- **Lerd** checkout: `referances/lerd`, commit `cf17e44` (2026-10-27), top
  CHANGELOG entry `1.38.0-beta.2` (`referances/lerd/CHANGELOG.md:10`).
- **WPXen**: branch `develop` at `9498b09`.

**Path convention.** Lerd paths below are relative to `referances/lerd/`.
WPXen paths are relative to the repo root (`electron/…`, `src/…`). `path:line`
points at the declaration (a cobra `Use:` line, a function, a schema entry).
"Doc" means the claim comes only from Lerd's docs or README and was not traced
into Go code.

---

## 1. Summary

- **The biggest gap is the AI half, which is the half WPXen says it leads on.**
  Lerd ships an MCP server with 12+ grouped, action-driven tools
  (`internal/mcp/groups.go:335-574`), a `mcp:inject` that writes MCP config and
  skill/rules files for nine AI clients into a project
  (`internal/cli/mcp.go:44-62`), and one-command global registration
  (`internal/cli/mcp.go:233`, `internal/cli/aiclients.go:168-283`). WPXen embeds
  the agents (terminals, chat view, handoff, Tasks), but it gives them no
  structured access to the environment. There's no MCP server (the README only
  lists MCP as "future", `README.md:278`), and a session gets the site's PHP on
  PATH and nothing else (`electron/services/shellIntegration.cjs:3`,
  `electron/services/agents.cjs:872`). **Highest-value adoption:** a WPXen MCP
  server for WordPress, plus per-site context injection into Agent sessions.
- **No database safety net before agents edit things.** Lerd has named DB
  snapshots and restore (`internal/cli/db_snapshot.go:17-26`), scheduled
  snapshots with retention (`internal/cli/db_snapshot_auto.go:20`), and it
  snapshots before destructive operations (README "Nothing destructive without a
  way back"). WPXen has whole-site Blueprints (`electron/services/blueprints.cjs:22`),
  but no quick DB snapshot. Removing a site drops its database by default with
  no backup (`electron/services/wordpress.cjs:347-351`). For agent-driven work
  this matters more than for hand edits.
- **Debugging is a whole category WPXen lacks**: Xdebug toggle with modes and
  on-demand triggering (`internal/cli/xdebug.go:17-50`), a dump/debug window
  (`internal/cli/dump.go:28`), SPX flame-graph profiling
  (`internal/cli/profile.go:17`), nginx-fed request timing
  (`internal/reqstats/record.go:1-6`) and browser console/error capture
  (`internal/cli/browser_logs.go:18`). WPXen's own roadmap already lists Xdebug
  as missing (`docs/features/FEATURES.md:24,72`).
- **Git worktrees as served sites.** Lerd serves each worktree at
  `branch.site.test`, with cert SANs (`internal/certs/secure.go:121`), the URL
  key rewritten in the env file, including WordPress's `WP_HOME`
  (`internal/git/worktree.go:324,332`), and per-worktree DB cleanup
  (`internal/cli/worktree_db.go:24`). WPXen already creates worktrees for Tasks
  (`electron/services/taskStart.cjs:141-166`), but they aren't served, so an
  agent on a worktree branch can't preview its own work.
- **DNS model worth copying.** On macOS, Lerd's own DNS server listens on
  **port 5300**, and `/etc/resolver/<tld>` names that port
  (`internal/dns/setup_darwin.go:23`). The privileged step is a one-time resolver
  write. WPXen runs dnsmasq on :53 as a root LaunchDaemon
  (`electron/services/dnsmasq.cjs:42-45`), which is the only reason it still
  uses `brew services`. It's also why its sudoers file grants NOPASSWD
  `brew services start|stop|restart *` (`electron/services/sudoers.cjs:44-56`).
  Moving dnsmasq to an unprivileged port under procman could remove both.
- **Sharing is narrower.** Lerd supports six tunnel providers
  (`internal/cli/share_tool.go:45`), stable named-tunnel URLs on your own domain
  (`internal/cli/share_domain.go:15`) and LAN sharing with a QR code
  (`internal/cli/lan.go:178,224`). WPXen has Cloudflare quick tunnels only, with
  a new random `trycloudflare.com` URL every time
  (`electron/services/cloudflared.cjs:106,157`).
- **Health checks.** Lerd has `doctor --fix/--dry-run/--json`
  (`internal/cli/doctor.go:37-47`), a per-site doctor with one-click fixes
  (`internal/cli/site_doctor.go:24`, `internal/sitedoctor/`) and automatic cert
  reissue 30 days before expiry (`internal/certs/manager.go:16-20`). WPXen
  checks dependencies (`electron/services/brew.cjs:247`), but has no repair
  flow and no handling for certificate expiry.
- **WPXen is far deeper on WordPress itself.** Lerd treats WordPress as one
  framework among 14. It detects WP, reads and writes `wp-config.php` constants
  (`internal/envfile/phpconst.go:10`) and passes `--allow-root` to wp-cli
  (`internal/config/framework.go:85`). Its walkthrough has you download WP and
  run the installer by hand (`docs/getting-started/wordpress.md`). WPXen's
  install wizard, plugin/theme/core management, magic login, `.wpress` import,
  clone, change-URL and the tunnel URL-rewrite mu-plugin have no Lerd
  equivalent.
- **Lerd's query capture probably misses WordPress.** Its engine-level observer
  hooks `PDO`/`PDOStatement` (`internal/podman/devtools/lerd_devtools.c:518,556`),
  and there are no `mysqli` hooks in the extension or the PHP collector.
  WordPress's `$wpdb` uses mysqli, so if WPXen builds a query lens it needs its
  own approach (e.g. `SAVEQUERIES` / a mu-plugin on the `query` filter).

---

## 2. Platform and architecture differences

| Dimension       | Lerd                                                                                                                                                                                                                                 | WPXen                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platforms       | Linux, macOS, Windows via WSL2 (`README.md`; `internal/cli/wsl.go:28`)                                                                                                                                                               | macOS only                                                                                                                                                       |
| Runtime         | Rootless **Podman containers** for nginx, PHP-FPM, services (`internal/podman/quadlet*.go`); on macOS a Podman VM, with an opt-in **native host PHP** mode (`internal/cli/php_runtime.go:28`)                                        | **Native Homebrew binaries** supervised as app children (`electron/services/procman.cjs:6`)                                                                      |
| Binaries        | Pulls OCI images; pins host tools (composer, mise, fnm) behind a manifest (`internal/cli/tools_update.go:19`, `internal/tools/tools.go`)                                                                                             | Never bundles. Shells out to the user's Homebrew (CLAUDE.md)                                                                                                     |
| Process model   | Go binary: CLI + long-running `lerd-ui` (web UI on :7073) + watcher; units under systemd/launchd (`cmd/lerd/main.go:357,475`)                                                                                                        | One Electron app; main process owns everything, no daemon (`docs/adr/0001-main-process-pty-no-daemon.md`)                                                        |
| Primary UI      | Embedded Svelte web UI (`internal/ui/web/`) + TUI (`internal/cli/tui.go:18`) + CLI (≈280 cobra commands) + optional tray (`cmd/lerd-tray`) + optional desktop wrapper (external repo)                                                | Electron React app + menu-bar tray (`electron/tray.cjs`). **No CLI**                                                                                             |
| Extensibility   | Store-first: frameworks and services are versioned YAML fetched from `lerd-env/*` repos, shipped without a binary release (`CLAUDE.md` §1, §5; `internal/store/`, `internal/registry/`); plugin system (`internal/cli/plugin.go:24`) | Hardcoded modules; agent registry is data-shaped but in code (`electron/services/agents.cjs:42`) plus user-defined agents (`electron/services/settings.cjs:189`) |
| Framework scope | Framework-agnostic by design law (`CLAUDE.md` §1.2)                                                                                                                                                                                  | WordPress-only by design                                                                                                                                         |

**What this means for portability:**

- **Ports cleanly** (pure logic or macOS-native concepts): MCP server and context
  injection, DB snapshots, Xdebug toggling (Homebrew PHP loads `xdebug.so` from
  conf.d just like any ini), request timing from nginx access logs, site and env
  doctor, cert reissue, worktree-as-site, LAN share + QR, multiple tunnel
  providers, notifications, unprivileged DNS port.
- **Ports with Homebrew constraints**: extra services (Redis, PostgreSQL,
  Meilisearch) must be `brew install`ed and supervised by procman, not pulled as
  images. PHP extensions mean `pecl`, which is fragile on Homebrew PHP, so treat
  that as Low. A profiler (SPX) would need building per PHP version, since there
  is no brew formula. All of these must respect the CLAUDE.md
  "verify the brew package before adding" rule.
- **Doesn't transfer**: container-specific features (custom containers,
  Containerfile sites, image pulls, Podman machine memory/reclaim, `--no-pull`
  offline mode, FrankenPHP images, Sail import), Linux/WSL/NixOS packaging, and
  framework-store machinery that exists to stay framework-agnostic.

---

## 3. Feature matrix

Status values: **Exists**, **Partial**, **Missing**, **N/A** (doesn't apply to
WPXen's model).

### 3.1 Site management

| Feature                                                     | Lerd (how)                                                                                                                     | WPXen   | WPXen evidence                                                                                                                      | Notes                                                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Create a new project                                        | `lerd new` scaffolds from the framework store (`internal/cli/new.go:31`)                                                       | Exists  | `electron/services/wordpress.cjs:172` (streamed WP install), `src/components/AddSiteModal.jsx`                                      | WPXen's flow is WP-specific and much richer (admin user, locale, version)                                                    |
| Register an existing folder in place                        | `lerd link` (`internal/cli/link.go:54`), `unlink` (`internal/cli/unlink.go:49`)                                                | Missing | `src/components/AddSiteModal.jsx:12-14` offers only blank or blueprint                                                              | Import exists, but only from an archive (`electron/services/siteops.cjs:311`), not "serve this folder"                       |
| Park a directory (auto-serve every subdir)                  | `lerd park` (`internal/cli/park.go:112`), detects `wp-login.php` (`internal/watcher/parked.go:17`)                             | Missing | —                                                                                                                                   |                                                                                                                              |
| Extra domains/aliases per site                              | `lerd domain add` (`internal/cli/domain.go:28`)                                                                                | Partial | `electron/services/nginx.cjs:227-242` supports `aliases`; only set transiently by tunnels (`electron/services/cloudflared.cjs:138`) | The vhost code is ready; there's no UI or persistence                                                                        |
| Site groups (main site + subdomains, shared or separate DB) | `lerd group` (`internal/cli/group.go:17,35,46`)                                                                                | Missing | —                                                                                                                                   | Relevant to subdomain multisite, which WPXen also lacks (`electron/services/siteops.cjs:189-190` warns on multisite imports) |
| Pause/unpause a site                                        | `internal/cli/pause.go:27,44`                                                                                                  | Missing | —                                                                                                                                   | Low value without workers                                                                                                    |
| Committed project config                                    | `.lerd.yaml` via `lerd init` (`internal/cli/init.go:29`; schema `internal/config/project.go:49-92`)                            | Missing | Site records live in `userData` (`electron/store.cjs`); Launch Targets on the record (`CONTEXT.md`)                                 | A committed `wpxen.json` could carry PHP version and Launch Targets                                                          |
| Site registry backups/restore                               | Timestamped backups on every write (`internal/config/site_backup.go:45`), `sites:restore` (`internal/cli/sites_restore.go:17`) | Partial | Atomic write (`electron/store.cjs:51-56`), corrupt file set aside (`electron/store.cjs:41`)                                         | No restore path                                                                                                              |
| Workspaces (group sites in UI)                              | `internal/cli/workspace.go:18`                                                                                                 | Partial | Agents Projects list, ordered, opt-in (`electron/services/agentProjects.cjs`)                                                       |                                                                                                                              |
| Streaming mode (hide private sites when screen sharing)     | `internal/cli/streaming.go:17`; Wayland detection (`internal/screenshare/screenshare.go:1-3`)                                  | Missing | —                                                                                                                                   | Low                                                                                                                          |

### 3.2 Git and worktrees

| Feature                                      | Lerd (how)                                                                                                                           | WPXen   | WPXen evidence                                                                                                | Notes                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Worktree served at its own subdomain         | Auto-detected (`internal/git/worktree.go:53,101`); cert SANs cover worktrees (`internal/certs/secure.go:121`)                        | Partial | Worktrees created for Tasks (`electron/services/taskStart.cjs:141-166`); agent launched there, **not served** | See Recommendation H2                                                                                                                                              |
| Worktree env/URL rewrite                     | `EnsureWorktreeEnv` rewrites `WP_HOME` in `wp-config.php` for WordPress (`internal/git/worktree.go:324,332`)                         | Missing | —                                                                                                             | For WP, `WP_HOME` alone isn't enough: `siteurl` and content URLs live in the DB (search-replace needed; WPXen already has it, `electron/services/siteops.cjs:572`) |
| Per-worktree database                        | Isolated DBs, dropped when orphaned (`internal/cli/worktree_db.go:24`); `db:isolate`/`db:share` (`internal/cli/db_isolate.go:15,54`) | Missing | —                                                                                                             |                                                                                                                                                                    |
| `worktree add/remove/setup` CLI              | `internal/cli/worktree_add.go:26`, `worktree_remove.go:24`, `worktree_setup.go:25`                                                   | Partial | Task Start modes `branch/worktree/current` (`electron/services/taskStart.cjs:22,148`)                         |                                                                                                                                                                    |
| Git status / stage / unstage / diff          | `internal/git/commit.go:10,17`, `internal/git/diff.go`                                                                               | Exists  | `electron/services/git.cjs:245,281,318,325,334`                                                               |                                                                                                                                                                    |
| Commit / stash from UI                       | `CommitStaged` (`internal/git/commit.go:28`), `internal/git/stash.go`                                                                | Missing | No commit in `electron/services/git.cjs`                                                                      | Agents can commit in the terminal                                                                                                                                  |
| Branch pull/switch with dependency + DB plan | `PlanSitePull`/`PullSite` (`internal/cli/branch_pull.go:14,63`), `branch_switch.go`                                                  | Missing | —                                                                                                             |                                                                                                                                                                    |
| PR checkout                                  | — (not found)                                                                                                                        | Exists  | `electron/services/github.cjs:1340`                                                                           | WPXen-only (Tasks)                                                                                                                                                 |

### 3.3 PHP and runtimes

| Feature                              | Lerd (how)                                                                                                                                                                                       | WPXen       | WPXen evidence                                                                                                                                          | Notes                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Multiple PHP versions, global switch | `lerd use` (`internal/cli/use.go:47`), `php:list` (`internal/cli/php_list.go:15`)                                                                                                                | Exists      | `electron/services/php.cjs:348`                                                                                                                         |                                                                 |
| Per-site PHP version                 | `lerd isolate` (`internal/cli/isolate.go:20`)                                                                                                                                                    | Exists      | One FPM per needed version on its own socket (`electron/services/php.cjs:89,286,321`); vhost uses the site's socket (`electron/services/nginx.cjs:303`) | `plans/per-site-php.md` is implemented in code                  |
| Install/update PHP versions          | `php:update` (`internal/cli/php_update.go:21`)                                                                                                                                                   | Exists      | `electron/services/php.cjs:461,472`; EOL via tap (`electron/services/php.cjs:454`)                                                                      |                                                                 |
| php.ini editing                      | Per version or shared (`internal/cli/php_ini.go:14`), backups via `internal/cfgedit/cfgedit.go:1-6`                                                                                              | Exists      | `electron/services/php.cjs:839,856,871` (single + all versions)                                                                                         | Lerd edits the full file with backups; WPXen edits managed keys |
| Per-site ini overrides               | Not found at site scope (`php:ini [version\|shared]`)                                                                                                                                            | Exists      | `fastcgi_param PHP_VALUE` (`electron/services/nginx.cjs:274`, `electron/services/php.cjs:614,633`)                                                      | WPXen-only                                                      |
| PHP extensions add/remove            | `php:ext` (`internal/cli/php_ext.go:26,37,131`), Alpine packages `php:pkg` (`internal/cli/php_pkg.go:22`)                                                                                        | Missing     | —                                                                                                                                                       | On Homebrew this is `pecl`; fragile                             |
| **Xdebug** toggle, modes, on-demand  | `xdebug on --mode … --on-demand` (`internal/cli/xdebug.go:17-50`), break into a running process (`internal/cli/xdebug_pause.go:28`)                                                              | **Missing** | `docs/features/FEATURES.md:24` ❌                                                                                                                       | README lists Xdebug as part of the product (`README.md:274`)    |
| FPM pool sizing                      | Native pools "run on demand", drop to zero when idle (Doc: `docs/features/native-runtime.md`)                                                                                                    | Partial     | `pm = dynamic`, `start_servers = 2` per version (`electron/services/php.cjs:109-113`)                                                                   | `pm = ondemand` is a cheap win with many versions running       |
| FrankenPHP runtime                   | `lerd runtime frankenphp` (`internal/cli/runtime.go:33`)                                                                                                                                         | Missing     | —                                                                                                                                                       | Low for WP                                                      |
| Container vs native PHP              | `php:runtime` (`internal/cli/php_runtime.go:28`)                                                                                                                                                 | N/A         | Always native                                                                                                                                           |                                                                 |
| Composer / vendor-bin exec           | `internal/cli/composer_exec.go:22`, `internal/cli/vendor_bin.go:28`, `cpx` (`internal/cli/cpx_exec.go:18`)                                                                                       | Partial     | Site PHP put first on PATH in terminals (`electron/services/shellIntegration.cjs:3`)                                                                    | Composer isn't detected or managed                              |
| Node version per project             | `node:install/use/manager` (`internal/cli/node_install.go:12`, `node_use.go:15`, `node_manage.go:66`), `isolate:node` (`internal/cli/isolate_node.go:17`), bun (`internal/cli/js_runtime.go:20`) | Missing     | `docs/features/FEATURES.md` Tier 2 #11                                                                                                                  | Relevant to block/theme builds (`@wordpress/scripts`)           |

### 3.4 Databases and services

| Feature                                | Lerd (how)                                                                                                                              | WPXen   | WPXen evidence                                                                                                                                | Notes                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| MySQL                                  | Built-in preset (`internal/config/presets/mysql.yaml`)                                                                                  | Exists  | `electron/services/mysql.cjs:142` (supervised)                                                                                                |                                           |
| PostgreSQL, Redis, Meilisearch, RustFS | Built-in presets (`internal/config/presets/*.yaml`); more from store (`internal/cli/services.go:797,1010`)                              | Missing | `services.autoStart` allows only nginx/php/mysql/mailpit (`electron/services/settings.cjs:236-242`)                                           | Redis matters for WP object-cache testing |
| Custom service from any image          | `service add` (`internal/cli/services.go:698`)                                                                                          | N/A     | —                                                                                                                                             | Container-only                            |
| Service pin/update/rollback/migrate    | `internal/cli/services.go:368,484,554,1281`                                                                                             | Partial | Outdated detection for PHP formulae only (`electron/services/brew.cjs:206`, `electron/services/php.cjs:412`)                                  |                                           |
| Change service port / expose           | `internal/cli/services.go:1322,1234`                                                                                                    | Missing | —                                                                                                                                             |                                           |
| Edit service config with backups       | `service config` (`internal/cli/service_config.go:50`) via `cfgedit` (`internal/cfgedit/cfgedit.go:272,294`)                            | Missing | —                                                                                                                                             | e.g. `my.cnf`                             |
| DB create / drop / list                | `db:create` (`internal/cli/db.go:29,49`)                                                                                                | Partial | `electron/services/mysql.cjs:222,229,234`, used only inside site lifecycle; no UI                                                             |                                           |
| DB import / export                     | `db:import/export` (`internal/cli/db.go:27-28,58,74`)                                                                                   | Partial | `electron/services/mysql.cjs:314,348`, reached only through Export/Import Site (`electron/services/siteops.cjs:228,311`) and phpMyAdmin       |                                           |
| DB shell                               | `db:shell` (`internal/cli/db.go:30,52`)                                                                                                 | Partial | phpMyAdmin auto-login (`electron/services/phpmyadmin.cjs:44`)                                                                                 |                                           |
| **Named DB snapshots + restore**       | `db:snapshot/snapshots/restore/snapshot:rm/keep` (`internal/cli/db_snapshot.go:17-26`)                                                  | Partial | Blueprints are full-site (files + DB) snapshots (`electron/services/blueprints.cjs:22,78`), too heavy for "before the agent runs a migration" | See Recommendation H1                     |
| Scheduled snapshots with retention     | `db:snapshot:auto` (`internal/cli/db_snapshot_auto.go:20`); MCP `auto_set` (`internal/mcp/groups.go:404`)                               | Missing | —                                                                                                                                             |                                           |
| Snapshot before destructive ops        | Doc: README "Nothing destructive without a way back"; `remove --purge`, `reinstall --reset-data` (`internal/cli/services.go:1073,1123`) | Missing | `remove-site` drops the DB by default (`electron/services/wordpress.cjs:347-351`) and `rmSync`s files when asked (`:354-356`)                 |                                           |
| Admin dashboards opened logged in      | Doc: README; the phpMyAdmin/Adminer presets live in the external store (not vendored)                                                   | Exists  | `electron/services/phpmyadmin.cjs:29,44`; per-site DB deep link (`electron/ipc.cjs:2363`)                                                     |                                           |
| Host DB client shims                   | `internal/cli/client_shims.go:42`                                                                                                       | N/A     | Homebrew `mysql` is already on the host                                                                                                       |                                           |
| JetBrains data source sync             | `internal/cli/ide_datasource.go:35`, `internal/ide/jetbrains.go:1`                                                                      | Missing | —                                                                                                                                             | Low                                       |

### 3.5 DNS and TLS

| Feature                               | Lerd (how)                                                                                                                                                                                                               | WPXen                    | WPXen evidence                                                                                                                                              | Notes                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `*.test` resolution                   | Built-in Go DNS server reading dnsmasq-style config (`internal/dnsserver/dnsserver.go:1-4`; `internal/cli/dns_serve.go:23`) on **port 5300**; `/etc/resolver/<tld>` says `port 5300` (`internal/dns/setup_darwin.go:23`) | Exists (different model) | dnsmasq on :53 as a root LaunchDaemon via `brew services` + sudo (`electron/services/dnsmasq.cjs:42-45`); edits Homebrew's shared `dnsmasq.conf` (`:66-79`) | See Recommendation H4                                            |
| Privilege footprint for DNS           | One sudo write of the resolver file (`internal/dns/setup_darwin.go:75`); a narrow sudoers rule for that file only (`:117-131`)                                                                                           | Partial                  | sudoers grants `%admin` NOPASSWD `brew services start\|stop\|restart *` (`electron/services/sudoers.cjs:44-56`)                                             | The wildcard covers any formula, not just dnsmasq                |
| DNS check / repair / enable / disable | `dns:check` (`cmd/lerd/main.go:370`), `dns:enable/disable/repair` (`internal/cli/dns_toggle.go:20,31,43`)                                                                                                                | Partial                  | `setupComplete` (`electron/services/dnsmasq.cjs:118`), one-click setup (`electron/ipc.cjs:2854`)                                                            | No repair or diagnosis                                           |
| Opt out to `.localhost` / custom TLD  | Doc: `docs/features/dns.md:11-24`; TLD migration (`internal/cli/migrate_tld.go`)                                                                                                                                         | Missing                  | TLD fixed to `test` (`electron/services/dnsmasq.cjs`)                                                                                                       | Low                                                              |
| Per-site HTTPS (mkcert)               | `secure`/`unsecure` (`internal/cli/secure.go:20,32`; `internal/certs/secure.go:26`)                                                                                                                                      | Exists                   | `electron/services/mkcert.cjs:60,120`; `electron/ipc.cjs:1527`                                                                                              |                                                                  |
| Auto-reissue before expiry            | 30-day window (`internal/certs/manager.go:16-20`), checked on every boot (`internal/certs/secure.go:83-91`)                                                                                                              | Missing                  | No expiry logic in `electron/services/mkcert.cjs`                                                                                                           | mkcert leaves last about 2 years; long-lived sites will hit this |
| CA trust: system + browser NSS stores | `internal/certs/ca_trust_darwin.go:150`, `internal/certs/browser_trust.go:98,131`                                                                                                                                        | Partial                  | Login keychain only (`electron/services/mkcert.cjs:91-101`); trust status (`:104`)                                                                          | Firefox users may see warnings (unverified on a live machine)    |

### 3.6 Mail

| Feature                       | Lerd (how)                                                                                                              | WPXen   | WPXen evidence                                                                             | Notes                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Mail catching (Mailpit)       | Preset (`internal/config/presets/mailpit.yaml`); `mail()` routed by a conf.d ini (`internal/podman/mail.go`, `MailIni`) | Exists  | `electron/services/mailpit.cjs:98,195`                                                     | Same approach                                                            |
| In-app inbox                  | Mailpit dashboard proxied same-origin (`internal/config/presets/mailpit.yaml` `dashboard_proxy_*`)                      | Exists  | Native inbox via REST (`electron/services/mailpit.cjs:259-292`, `src/components/Mail.jsx`) |                                                                          |
| Notification on captured mail | Mailpit webhook → notifier (`internal/ui/mailpit_webhook.go`)                                                           | Missing | Notifications cover agents only (`electron/ipc.cjs:816`)                                   |                                                                          |
| Mail for agents               | Not in Lerd's MCP tool list (`internal/mcp/groups.go`)                                                                  | Missing | —                                                                                          | WPXen could do better: "wait for mail, return the reset link" for agents |

### 3.7 Tunnels and sharing

| Feature                                    | Lerd (how)                                                                                                                                          | WPXen   | WPXen evidence                                                                                                      | Notes                               |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Public tunnel                              | `lerd share` (`internal/cli/share.go:43`); providers ngrok, cloudflared, Expose, Pinggy, serveo, localhost.run (`internal/cli/share_tool.go:45-55`) | Partial | Cloudflare quick tunnel only (`electron/services/cloudflared.cjs:157`)                                              |                                     |
| Stable public URL                          | Named Cloudflare tunnel on a user domain (`internal/cli/share_domain.go:15-27`); ngrok/pinggy tokens (`internal/cli/share_token.go:41`)             | Missing | New random URL each run (`electron/services/cloudflared.cjs:106`)                                                   | FEATURES Tier 3 #12                 |
| LAN share with stable port + QR            | `lan share` (`internal/cli/lan.go:178`), QR (`internal/cli/lan.go:224`, `internal/cli/lanshare.go:19`)                                              | Missing | —                                                                                                                   | Mobile testing; FEATURES Tier 3 #12 |
| WP URL rewrite for shares                  | Not found                                                                                                                                           | Exists  | `electron/services/wordpress.cjs:446-480` (tunnel mu-plugin), nginx alias (`electron/services/cloudflared.cjs:137`) | WPXen-only                          |
| Remote laptop provisioning / LAN dashboard | `remote-setup` (`internal/cli/remote_setup.go:148`), `remote-control` (`internal/cli/remote_control.go:30`)                                         | Missing | —                                                                                                                   | Low                                 |

### 3.8 Logs, debugging, observability

| Feature                                    | Lerd (how)                                                                                                                                                                    | WPXen   | WPXen evidence                                                                                                                      | Notes                                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Per-site logs                              | `lerd logs` (`internal/cli/logs.go:19`); live streaming registry (`internal/ui/log_stream_registry.go`)                                                                       | Partial | `debug.log`, nginx error/access, php-fpm (`electron/services/logs.cjs:11-36`); 256 KB tail, read on request, no live tail (`:9`)    |                                                                                                           |
| Debug window (dumps, queries, mail, HTTP…) | `lerd dump` (`internal/cli/dump.go:28`); `auto_prepend_file` bridge (`internal/podman/dumpbridge/dump-bridge.php`) + C extension (`internal/podman/devtools/lerd_devtools.c`) | Missing | —                                                                                                                                   | Query capture is PDO-only (`lerd_devtools.c:518,556`); no mysqli                                          |
| Request timing (p50/p95, slow routes)      | nginx `log_format lerd_access … $request_time …` (`internal/nginx/templates/nginx.conf:33`) → `internal/reqstats/`                                                            | Missing | —                                                                                                                                   | Framework-agnostic, so it works for WP as-is                                                              |
| Browser console/error capture              | `browser-logs` (`internal/cli/browser_logs.go:18`), injected script (`internal/browserlogs/browser.js`)                                                                       | Missing | WPXen owns a `<webview>` (`electron/services/browser.cjs:146`)                                                                      | WPXen can capture console output natively from the guest webContents                                      |
| SPX profiler                               | `lerd profile` (`internal/cli/profile.go:17`)                                                                                                                                 | Missing | —                                                                                                                                   | No Homebrew formula; Medium/Low                                                                           |
| REPL / tinker                              | Web UI Tinker with LSP (Doc: `docs/features/tinker.md`)                                                                                                                       | Partial | Agent/floating terminals can run `wp shell`                                                                                         |                                                                                                           |
| Environment doctor with fixes              | `doctor --fix --dry-run --json` (`internal/cli/doctor.go:37-47`)                                                                                                              | Partial | Dependency check (`electron/services/brew.cjs:247`, `electron/ipc.cjs:2785`), onboarding install (`electron/services/setup.cjs:34`) |                                                                                                           |
| Site doctor                                | `site:doctor` (`internal/cli/site_doctor.go:24`); checks include http response, service wiring, DB presence, slow routes (`internal/sitedoctor/*.go`)                         | Missing | —                                                                                                                                   | WP version: wp-config sanity, DB reachable, `siteurl` ≠ domain, debug.log size, PHP-version compatibility |
| Bug-report bundle                          | `bug-report` (`internal/cli/bug_report.go:33`)                                                                                                                                | Missing | —                                                                                                                                   |                                                                                                           |

### 3.9 Process supervision and workers

| Feature                              | Lerd (how)                                                         | WPXen   | WPXen evidence                                                                                 | Notes                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------ | ------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Crash recovery                       | `worker heal` (`internal/cli/worker_heal_cmd.go:17`)               | Exists  | Crash restart with backoff (`electron/services/procman.cjs:42,274`), orphan reconcile (`:502`) | WPXen's is automatic                                                                                  |
| Framework workers (queue, schedule…) | `internal/cli/worker.go:23`                                        | N/A     | —                                                                                              | WP-Cron is the analogue; a "real cron" runner (`wp cron event run --due-now`) would be the WP version |
| Idle-suspend                         | `internal/cli/idle.go:21`                                          | Missing | —                                                                                              | Low                                                                                                   |
| Stripe webhook forwarding            | `stripe:listen` (`internal/cli/stripe.go:80`)                      | Missing | —                                                                                              | WooCommerce relevance; FEATURES Tier 3 #13                                                            |
| Dev server on the site's domain      | `internal/cli/devserver.go`                                        | Missing | —                                                                                              | Low                                                                                                   |
| Keep machine awake                   | Not found (`internal/power/` reads power state, a different thing) | Exists  | `electron/services/keepAwake.cjs:157`                                                          | WPXen-only                                                                                            |

### 3.10 AI, MCP and agent integration

| Feature                               | Lerd (how)                                                                                                                                                                                                                                                                                                                                                                                                                     | WPXen       | WPXen evidence                                                                                                                                              | Notes                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **MCP server**                        | `lerd mcp` over stdio (`internal/cli/mcp.go:22`); tools `site`, `service`, `db`, `env`, `runtime`, `worker`, `exec`, `framework`, `diag` (`internal/mcp/groups.go:335,363,404,439,455,478,512,542,574`), `logs` (`internal/mcp/logs.go:12`), `workspace` (`internal/mcp/workspace.go:15`), `worktree` (`internal/mcp/worktree.go:24`), `request` (`internal/mcp/request.go:14`), `plugin` (`internal/mcp/plugin_author.go:15`) | **Missing** | "Future … MCP" (`README.md:278`)                                                                                                                            | The core gap                                                                     |
| Per-project context injection         | `mcp:inject` writes `.mcp.json`, `.claude/skills/lerd/SKILL.md`, `.cursor/…`, `.junie/…`, `GEMINI.md`, `.vscode/mcp.json`, `AGENTS.md`, `opencode.json` (`internal/cli/mcp.go:44-62`); `mcp:eject` (`:75`)                                                                                                                                                                                                                     | Missing     | Sessions get site PHP on PATH only (`electron/services/shellIntegration.cjs:3`)                                                                             |                                                                                  |
| Global registration with AI clients   | `mcp:enable-global` (`internal/cli/mcp.go:233`); clients claude, cursor, junie, windsurf, codex, gemini, copilot, antigravity, opencode (`internal/cli/aiclients.go:168-283`)                                                                                                                                                                                                                                                  | Missing     | —                                                                                                                                                           | WPXen already detects most of these CLIs (`electron/services/agents.cjs:42-145`) |
| Consent gate inside tools             | Actions that would download disclose size and require `confirm: true` (`internal/mcp/groups.go:363` description)                                                                                                                                                                                                                                                                                                               | N/A yet     | WPXen's equivalent principle: never install unprompted (CLAUDE.md, `electron/services/agents.cjs:40-41`)                                                    | Carry the principle into any MCP tool                                            |
| "Copy for agent" handoff of a request | Doc: `docs/features/request-timing.md`; served by the `request` tool                                                                                                                                                                                                                                                                                                                                                           | Missing     | —                                                                                                                                                           |                                                                                  |
| PHP language server for agents        | `lerd lsp` (`internal/cli/lsp.go:17`, `internal/phpantom/`)                                                                                                                                                                                                                                                                                                                                                                    | Missing     | —                                                                                                                                                           | Low                                                                              |
| Embedded agent terminals              | **None.** Lerd stops at MCP                                                                                                                                                                                                                                                                                                                                                                                                    | Exists      | `electron/services/agents.cjs:872`, `electron/services/agentStatus.cjs:149`                                                                                 | WPXen-only                                                                       |
| One-click agent CLI install           | None                                                                                                                                                                                                                                                                                                                                                                                                                           | Exists      | `electron/services/agents.cjs:424,440,463,592`                                                                                                              | WPXen-only                                                                       |
| Agent chat view over transcripts      | None                                                                                                                                                                                                                                                                                                                                                                                                                           | Exists      | `electron/services/agentChat.cjs`, decoders `agentChatClaude.cjs` / `agentChatCodex.cjs` / `agentChatAntigravity.cjs`, `src/components/agents/ChatView.jsx` | WPXen-only                                                                       |
| Agent-to-agent handoff                | None                                                                                                                                                                                                                                                                                                                                                                                                                           | Exists      | `electron/services/handoff.cjs:61`                                                                                                                          | WPXen-only                                                                       |
| Issue/PR → agent session (Tasks)      | None                                                                                                                                                                                                                                                                                                                                                                                                                           | Exists      | `electron/services/github.cjs:199,348,576`, `electron/services/taskStart.cjs:148`                                                                           | WPXen-only                                                                       |

### 3.11 GUI, tray, notifications

| Feature                                           | Lerd (how)                                                                                                                                                               | WPXen       | WPXen evidence                                                                                                                                            | Notes                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Dashboard UI                                      | Embedded Svelte web UI served by `lerd-ui` (`cmd/lerd/main.go:357`, `internal/ui/`)                                                                                      | Exists      | Electron renderer (`src/components/`)                                                                                                                     | Different form, same role                   |
| CLI                                               | ≈280 cobra commands (root `cmd/lerd/main.go:84`)                                                                                                                         | **Missing** | —                                                                                                                                                         | An agent-facing CLI or MCP would close this |
| TUI                                               | `lerd tui` (`internal/cli/tui.go:18`)                                                                                                                                    | Missing     | —                                                                                                                                                         | Low                                         |
| Tray                                              | `lerd tray` (`internal/cli/tray.go:20`); per-service start/stop and PHP version submenus (Doc: `docs/features/system-tray.md`)                                           | Partial     | Status rows (`electron/tray.cjs:127-135`), sites with open/Finder/wp-admin (`:90-110`), agents needing attention (`:31-40`), keep-awake (`:58-66`)        | No start/stop or PHP switch from tray       |
| Notifications                                     | Native/web-push/in-dashboard bell with history (`internal/cli/notify.go:16`; `internal/ui/notify_*.go`; `internal/push/`) for mail, N+1, slow routes, updates, snapshots | Partial     | Agent alerts → `Notification`, dock badge, tray (`electron/ipc.cjs:816`, `electron/main.cjs:186`, `electron/services/agentStatus.cjs:298`)                |                                             |
| Command palette (Cmd+K)                           | Doc: README                                                                                                                                                              | Missing     | Not found in `src/`                                                                                                                                       |                                             |
| Edit nginx config in-app, validated, with backups | `nginx show/edit/reset` at server/location scope (`internal/cli/nginx.go:70,102,168`), `cfgedit`                                                                         | Partial     | `validateConfig` exists (`electron/services/nginx.cjs:390`); raw wp-config editor (`electron/services/wordpress.cjs:749,757`); no per-site nginx override |                                             |
| Offline docs                                      | `lerd man` (`internal/cli/man.go:18`)                                                                                                                                    | Missing     | —                                                                                                                                                         | Low                                         |

### 3.12 Import, export, migration

| Feature                             | Lerd (how)                                                                       | WPXen  | WPXen evidence                                                                      | Notes      |
| ----------------------------------- | -------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------- | ---------- |
| Full site export/import archive     | Not found (DB import/export only)                                                | Exists | `electron/services/siteops.cjs:228,311`; `.wpress` (`electron/services/wpress.cjs`) | WPXen-only |
| Clone a site                        | Not found                                                                        | Exists | `electron/services/siteops.cjs:602`                                                 | WPXen-only |
| Change site URL with search-replace | Not found                                                                        | Exists | `electron/services/siteops.cjs:711`                                                 | WPXen-only |
| Import from Sail / S3 seed          | `sail` (`internal/cli/sail.go:15`), `s3:import` (`internal/cli/s3_import.go:24`) | N/A    | —                                                                                   |            |
| Legacy-name / format migration      | `minio:migrate` (`internal/cli/minio_migrate.go:17`), TLD migration              | Exists | `electron/services/rebrand.cjs`, legacy shims (CLAUDE.md "Legacy names")            |            |

### 3.13 Installation, updates, lifecycle

| Feature                     | Lerd (how)                                                                                                                        | WPXen   | WPXen evidence                                                                                                   | Notes                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Self-update                 | `lerd update` (`internal/cli/update.go:35`), betas (`internal/cli/update_beta.go:16`), `whatsnew` (`internal/cli/whatsnew.go:16`) | Missing | No `autoUpdater`/`electron-updater` in `electron/` or `package.json`                                             |                                                                                                  |
| Autostart at login          | `autostart enable` (`internal/cli/autostart.go:49`)                                                                               | Exists  | `electron/ipc.cjs:277`                                                                                           |                                                                                                  |
| Auto-start services         | `lerd start`                                                                                                                      | Exists  | `electron/services/settings.cjs:236`                                                                             |                                                                                                  |
| Uninstall / cleanup         | `uninstall` (`internal/cli/uninstall.go:25`), `cleanup` (`internal/cli/cleanup.go:18`)                                            | Partial | sudoers removal (`electron/services/sudoers.cjs:112`); nothing removes vhosts, `/etc/resolver/test`, FPM configs |                                                                                                  |
| Dependency install          | Installer offers `brew install podman` (README)                                                                                   | Exists  | `electron/services/setup.cjs:34`                                                                                 |                                                                                                  |
| Plugin system               | `plugin install/new/list` (`internal/cli/plugin.go:24-99`)                                                                        | Missing | —                                                                                                                | Low for now                                                                                      |
| Store-delivered definitions | Framework/service YAML fetched without a release (`internal/store/`, `CLAUDE.md` §5)                                              | Missing | Agent registry in code (`electron/services/agents.cjs:42`)                                                       | Possible fit: a remote agent registry. Weigh it against the CLAUDE.md "verify brew package" rule |

### 3.14 Framework support

| Feature                                   | Lerd (how)                                                       | WPXen  | WPXen evidence                                                                   | Notes      |
| ----------------------------------------- | ---------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------- | ---------- |
| Multi-framework                           | 14 frameworks via store (README; `internal/config/framework.go`) | N/A    | WP-only by design                                                                |            |
| WordPress detection                       | `wp-login.php` (`internal/watcher/parked.go:17`)                 | Exists | Sites are created by WPXen; version read (`electron/services/wordpress.cjs:604`) |            |
| wp-config.php read/write                  | `ReadPhpConst` (`internal/envfile/phpconst.go:10`)               | Exists | Managed + raw editor (`electron/services/wordpress.cjs:680,714,749`)             |            |
| WP install, plugins, themes, core updates | Not provided; manual steps (`docs/getting-started/wordpress.md`) | Exists | `electron/services/wordpress.cjs:172,781,900,907,950,1005,1022`                  | WPXen-only |
| Magic login                               | Not found                                                        | Exists | `electron/services/wordpress.cjs:538`                                            | WPXen-only |

---

## 4. Recommendations

Effort: **S** about a day, **M** a few days, **L** a week or more.

### High

**H1. Database snapshots, plus a snapshot before every destructive operation.** — Effort **M**

- _Why:_ when an agent runs a migration, a search-replace or a plugin
  activation, a cheap way back is what makes autonomy safe. Lerd treats this as
  a design principle. WPXen's Blueprints are the right idea at the wrong grain.
- _Shape:_ `snapshot(siteId, name?)` / `listSnapshots` / `restore` /
  `deleteSnapshot` built on the existing `dumpDatabase`/`importDatabase`
  (`electron/services/mysql.cjs:314,348`). Store gzipped dumps under
  `userData/snapshots/<siteId>/`. Snapshot automatically before `remove-site`
  (`electron/ipc.cjs:1491`), `change-site-url`, import-over-existing and
  `update-wp-all`. Optional retention-limited schedule later.
- _Touches:_ `mysql.cjs`, new `services/snapshots.cjs` (electron-free so it's
  testable), `ipc.cjs` + `preload.cjs`, a Snapshots card in `SiteDetail.jsx`.
- _Constraints:_ settings for retention need both `settings.cjs` and
  `src/lib/settingsRegistry.js`. Keep the snapshot dir name a constant (rename
  rule). No `require('electron')` at module scope.

**H2. A WPXen MCP server for WordPress, plus context injection into Agent sessions.** — Effort **L** (an MVP is M)

- _Why:_ this is the positioning claim ("agents as first-class participants",
  `README.md:5`). Lerd shows the pattern works: grouped tools with an `action`
  enum (`internal/mcp/groups.go:335`), registration per client
  (`internal/cli/aiclients.go:168-283`), and a skill file. WPXen can beat it on
  WordPress depth because it already has the operations. Suggested tools:
  `site` (list/info/url/php), `wp` (run WP-CLI with the site's PHP via
  `wpAsync`, `electron/services/wordpress.cjs:128`), `db` (snapshot/restore/
  query, from H1), `logs` (`electron/services/logs.cjs:42`), `mail` (list, read,
  wait-for and extract links, `electron/services/mailpit.cjs:259,277`),
  `browser` (console errors from the in-app webview).
- _Transport choice:_ Lerd's MCP is a stdio subprocess of the CLI. WPXen has no
  CLI, so the options are (a) a small stdio shim spawned by the agent that talks
  to the running app over a local socket, or (b) an HTTP/SSE MCP endpoint on
  loopback in the main process. Either needs an ADR next to `0001`.
- _Context injection:_ when `agents.launch` (`electron/services/agents.cjs:872`)
  spawns a session, offer to write `.mcp.json` / `AGENTS.md` /
  `.claude/skills/wpxen/SKILL.md` into the webroot (opt-in, the way Lerd's
  `mcp:inject`/`mcp:eject` pair works), or pass equivalent env vars. Never
  write silently into a user's repo.
- _Constraints:_ new IPC needs all three places. Files written into the user's
  project carry the `wpxen` name (rename rule: put names as constants by a
  `LEGACY_*` list). Each tool that installs something has to stay
  click-to-consent, like Lerd's `confirm: true`.

**H3. Xdebug toggle.** — Effort **M**

- _Why:_ WPXen's own roadmap ranks it Tier 1 #1 (`docs/features/FEATURES.md:72`).
  The README already claims it (`README.md:274`). Lerd's modes (`debug`,
  `coverage`, `profile`, `trace`) and `--on-demand` (`start_with_request=trigger`,
  `internal/cli/xdebug.go:40-50`) are the right surface.
- _Shape:_ install with `pecl install xdebug` against the version's keg, or
  verify a brew formula first per the CLAUDE.md rule. Write a
  `zz-wpxen-xdebug.ini` into that version's conf.d. Reload that version's FPM
  (`reloadPhpFpmIfRunning`, `electron/services/php.cjs:831`).
- _Touches:_ `php.cjs`, `PhpSettings.jsx` / `SitePhpSettings.jsx`, a setting
  for the default mode (schema + registry).
- _Constraints:_ the ini file name is a new name-carrying artifact. Add it to
  the legacy-cleanup lists `php.cjs` already maintains. There's no bundled
  binary, so pecl failures have to be surfaced cleanly.

**H4. Run dnsmasq unprivileged on a high port and drop the brew-services sudoers grant.** — Effort **M**

- _Why:_ Lerd's macOS model (`/etc/resolver/test` with `port 5300`,
  `internal/dns/setup_darwin.go:23`) needs root only for the one-time resolver
  write. WPXen could run dnsmasq with `--port=5300 --keep-in-foreground` under
  procman, with a WPXen-owned conf instead of editing Homebrew's shared
  `dnsmasq.conf` (`electron/services/dnsmasq.cjs:66-79`). That removes the last
  `brew services` user (CLAUDE.md), the per-start admin escalation, and the
  `NOPASSWD brew services *` grant for all of `%admin`
  (`electron/services/sudoers.cjs:44-56`).
- _Touches:_ `dnsmasq.cjs`, `procman.cjs` spec, `sudoers.cjs` (shrink or
  remove), `migration.cjs` (unregister the root service once), the resolver
  rewrite in the same privileged step, `settings.cjs` `services.autoStart`.
- _Constraints:_ legacy rules. The old sudoers file and the root dnsmasq plist
  are exactly the "orphaned grant" failure mode CLAUDE.md warns about, so the
  migration must remove them in the same privileged step. Live-verify on both
  arm64 and Intel prefixes.

**H5. Serve task worktrees as their own sites.** — Effort **L**

- _Why:_ WPXen already creates worktrees per task
  (`electron/services/taskStart.cjs:141-166`). Serving each one at
  `<branch>.<site>.test` lets an agent and the in-app browser preview the
  branch, which is Lerd's headline worktree feature
  (`internal/git/worktree.go:332`, `internal/certs/secure.go:121`).
- _WordPress-specific work Lerd doesn't do:_ WP stores `home`/`siteurl` and
  absolute content URLs in the DB, so a worktree needs either its own DB
  (clone + `searchReplaceHost`, `electron/services/siteops.cjs:572,602`) or
  `WP_HOME`/`WP_SITEURL` constants and an accepted shared-DB risk. Default to a
  cloned DB, and drop it when the worktree goes away (Lerd:
  `internal/cli/worktree_db.go:24`).
- _Touches:_ `taskStart.cjs`, `nginx.cjs` (wildcard or extra `server_name`),
  `mkcert.cjs` (SANs), `siteops.cjs`, `store` site records (a child-site
  concept), the Agents sidebar.

### Medium

**M1. Request timing from nginx access logs.** — Effort **M.** Add a
`log_format` with `$request_time` (Lerd: `internal/nginx/templates/nginx.conf:33`)
to WPXen's vhosts (`electron/services/nginx.cjs:222`), tail it in the main
process, and show p50/p95 and slow routes per site. It's framework-agnostic, so
it works for WP unchanged, and it pairs with the MCP `diag`-style tool. Watch
the CLAUDE.md note that vhost changes need an nginx reload.

**M2. Browser console and error capture from the in-app browser.** — Effort
**S–M.** Lerd injects a script (`internal/browserlogs/browser.js`). WPXen owns
the guest `webContents` (`electron/services/browser.cjs:146`) and can listen for
`console-message` / `did-fail-load` without touching the page. Expose it to
agents (H2) so "the page is broken" comes with the actual JS error. Mind the
webview "never move" rule. This is main-process listener work only.

**M3. Certificate expiry self-heal and broader trust.** — Effort **S.** Check
`notAfter` on boot and reissue inside a 30-day window (Lerd:
`internal/certs/manager.go:16-20`). Run `mkcert -install` with Firefox NSS
support when `nss` is present (Lerd: `internal/certs/browser_trust.go:131`).
Touches `mkcert.cjs` and a startup hook in `ipc.cjs`/`main.cjs`.

**M4. Doctor with repair (environment + site).** — Effort **M.** Extend
`checkAllDependencies` (`electron/services/brew.cjs:247`) into findings that each
carry a fix tier, like Lerd's `--fix --dry-run --json`
(`internal/cli/doctor.go:37-47`). Add WP site checks: DB reachable, `siteurl`
matches the domain, socket for the site's PHP is up, vhost present, `nginx -t`
passes (`electron/services/nginx.cjs:390`), cert valid, debug.log size.
Anything that needs sudo is shown, not run. That's Lerd's rule, and it matches
WPXen's admin-prompt model.

**M5. Better sharing: LAN + QR and stable tunnel URLs.** — Effort **M.** A LAN
share binds a per-site port on the LAN IP and shows a QR code (Lerd:
`internal/cli/lan.go:178,224`). For stable public URLs, support a named
Cloudflare tunnel on a user-owned domain (Lerd: `internal/cli/share_domain.go:15`).
The existing tunnel mu-plugin (`electron/services/wordpress.cjs:446`) already
handles host rewriting. Keep cloudflared as the only provider unless users ask
for others. Each extra provider is another binary to verify via brew.

**M6. Redis (object cache) as an optional supervised service.** — Effort **M.**
Lerd ships Redis as a default preset (`internal/config/presets/redis.yaml`). For
WP, Redis is what people test object caching against. `brew install redis`,
procman spec, and add `redis` to `services.autoStart`'s allowed list
(`electron/services/settings.cjs:236-242`). PostgreSQL and Meilisearch matter
less for WordPress.

**M7. FPM `pm = ondemand`.** — Effort **S.** Since per-site PHP can run several
versions at once, switch `buildFpmConfig` (`electron/services/php.cjs:109-113`)
to `ondemand` with a `process_idle_timeout`. Lerd's docs describe the same
choice for its native pools (`docs/features/native-runtime.md`; doc only). It's
a pure function and testable.

**M8. Live log tail.** — Effort **S.** Replace read-on-request
(`electron/services/logs.cjs:42`) with an `fs.watch` + offset stream to an open
SiteLogs pane, the way Lerd streams logs (`internal/ui/log_stream_registry.go`).

### Low

- **L1. Tray service controls and PHP switch** (Lerd tray menu,
  `docs/features/system-tray.md`). Touches `electron/tray.cjs`. **S.**
- **L2. Notifications beyond agents**: captured mail, service crash after
  backoff gives up, cert near expiry (Lerd: `internal/ui/notify_*.go`). Reuse
  `createNotifier` (`electron/services/agentStatus.cjs:298`). **S–M.**
- **L3. Link existing folder / park a directory** (Lerd `link`/`park`,
  `internal/cli/link.go:54`, `internal/cli/park.go:112`): "Add existing WordPress
  folder" in Add Site. **M.**
- **L4. Domain aliases UI** on top of the existing vhost support
  (`electron/services/nginx.cjs:227`). **S.**
- **L5. Self-update** via electron-builder's updater. **M.** Unrelated to Lerd's
  mechanism, but a real gap.
- **L6. Commit from the Changes pane** (Lerd `CommitStaged`,
  `internal/git/commit.go:28`). Touches `git.cjs`. **S.**
- **L7. Node version per site** (Lerd `isolate:node`) for block-theme builds,
  probably by detecting `.nvmrc` and prefixing PATH like
  `shellIntegration.cjs` does for PHP. **M.**
- **L8. Uninstall cleanup**: remove vhosts, FPM configs, `/etc/resolver/test`,
  sudoers in one privileged step (Lerd `internal/cli/uninstall.go:25`). **S–M.**
- **L9. A "real cron" toggle** (`DISABLE_WP_CRON` + supervised
  `wp cron event run --due-now` loop), the WordPress equivalent of Lerd's
  schedule worker. **S.**

**Not recommended:** container runtime, FrankenPHP, Podman machine tuning, the
plugin system, the framework store, TUI, multi-platform packaging,
`--no-pull`/offline image modes. These serve Lerd's framework-agnostic,
container-first model and cut against WPXen's Homebrew-native, WordPress-only
one.

---

## 5. What WPXen has that Lerd doesn't

- **Embedded agent workspace**: per-site pty Sessions with status tracking from
  OSC/BEL (`electron/services/agentStatus.cjs:84,149`), Launch Presets and
  Targets, split panes, a chat view over Claude/Codex/Antigravity transcripts
  (`electron/services/agentChat.cjs`), agent-to-agent handoff
  (`electron/services/handoff.cjs:61`), one-click agent CLI install
  (`electron/services/agents.cjs:592`), notes (`electron/services/notes.cjs:68`),
  keep-awake while agents work (`electron/services/keepAwake.cjs:157`). Lerd's
  agent story ends at MCP.
- **GitHub Tasks**: issues, PRs, checks, Projects, and "Start" turning an issue
  into a branch/worktree + agent session (`electron/services/github.cjs`,
  `electron/services/taskStart.cjs:148`).
- **In-app browser** with a persistent partition, scheme guard and DevTools
  (`electron/services/browser.cjs:108,146,175`).
- **File explorer/editor** (`electron/services/files.cjs:42`, CodeMirror).
- **Deep WordPress management**: install wizard, plugins/themes/core with
  auto-update toggles, admin users, wp-config managed + raw editor
  (`electron/services/wordpress.cjs:172,511,680,749,900-1022`).
- **One-click magic login** (`electron/services/wordpress.cjs:538`).
- **Site lifecycle**: export/import including `.wpress`, clone, change URL with
  search-replace, Blueprints (`electron/services/siteops.cjs:228,311,602,711`,
  `electron/services/wpress.cjs`, `electron/services/blueprints.cjs`).
- **Tunnel-aware WordPress URL rewriting** (`electron/services/wordpress.cjs:446-480`).
- **Per-site php.ini overrides** via `PHP_VALUE` (`electron/services/nginx.cjs:274`).
- **No VM or container overhead**: native Homebrew processes, so Lerd's macOS
  bind-mount penalty (the reason it built a native runtime,
  `docs/features/native-runtime.md`) doesn't exist here.

---

## 6. Open questions and unverified claims

**Lerd claims not verified in code (docs or external repos only):**

- Store contents. `lerd-frameworks/` and `lerd-services/` are referenced by
  `referances/lerd/CLAUDE.md` §2 but are **not in this checkout**. So the
  WordPress framework definition (workers, logs, doctor checks), the
  phpMyAdmin/Adminer presets and "admin dashboards open already logged in"
  couldn't be checked. Only the six embedded presets
  (`internal/config/presets/`) were verified.
- The README's "no dnsmasq, no system resolver tweak and no sudo for the DNS
  bits" doesn't hold on macOS. `/etc/resolver/<tld>` is written with sudo
  (`internal/dns/setup_darwin.go:75`) and a sudoers drop-in is installed
  (`:117-131`). The docs themselves say teardown "takes sudo"
  (`docs/features/dns.md:65`).
- Performance figures (62 → 238 rps native runtime) and "pools run on demand"
  are docs only (`docs/features/native-runtime.md`). The FPM pool config wasn't
  traced.
- The PhpStorm plugin, Omarchy widget, Lerd Desktop app and Windows installer
  are separate repos, so unverified.
- "Fifteen languages and twelve themes" and the Cmd+K palette are README claims;
  the Svelte sources under `internal/ui/web/` weren't audited.
- Query capture missing WordPress is an inference. No `mysqli` symbol appears in
  `internal/podman/devtools/lerd_devtools.c` or
  `internal/podman/dumpbridge/devtools-collector.php`, but a store-declared
  package seam (like the Ray one in `docs/features/dumps.md`) could add it from
  the unvendored store.
- `internal/power/` reads macOS power state (`power_darwin.go`). What it gates
  (the comment mentions "worker write") wasn't traced.

**WPXen doc drift found while verifying:**

- `README.md:108` says PHP-FPM "runs one php@x.x at a time". The code runs one
  FPM per needed version (`electron/services/php.cjs:286,321`).
- `README.md:187` says sockets are at `{prefix}/var/run/php/php{version}-fpm.sock`.
  They're actually at `{prefix}/var/run/wpxen/php<ver>.sock`
  (`electron/services/php.cjs:72,89`).
- `README.md` tech-stack table says Electron 28. `package.json:84` pins `^43.4.1`.
- `README.md:274` lists Xdebug as part of the product; it isn't implemented.
- `docs/features/FEATURES.md`'s comparison table still marks "AI / agentic
  coding" ❌ for WPXen, which the Agents section has made out of date.

**Design questions for WPXen before building H2/H5:**

- MCP transport: a stdio shim talking to the running app, or a loopback HTTP
  endpoint in the main process? Either way the app must be running, unlike
  Lerd's daemon-backed CLI.
- Should context injection write into the user's repo (`.mcp.json`,
  `AGENTS.md`), which then shows in git status, or be passed per session
  through env/flags only?
- Worktree sites: cloned DB per worktree (safe, slower, more disk) or a shared
  DB with `WP_HOME`/`WP_SITEURL` constants (fast, risky)? Lerd's default for
  WordPress isn't visible here because its worktree DB isolation is a
  plugin-provided job.
