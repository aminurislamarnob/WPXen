# WPHerd — Feature Roadmap

A comparison of WPHerd against leading local WordPress/PHP development tools, and a
prioritized list of features to implement. Compiled from:

- **Local (LocalWP)** — https://localwp.com/features/
- **Laravel Herd** — https://herd.laravel.com/
- **WordPress Studio** — https://developer.wordpress.com/docs/developer-tools/studio/
  and Studio Code — https://developer.wordpress.com/docs/developer-tools/studio/studio-code/

---

## Competitor comparison

| Capability | Local | Herd | Studio | **WPHerd today** |
|---|---|---|---|---|
| Native services (nginx / PHP / MySQL) | ✅ | ✅ | ✅ | ✅ |
| Multiple / hot-swap PHP versions | ✅ | ✅ | ✅ | ✅ |
| Mail catching (Mailpit) | ✅ | ✅ (Pro) | ✅ | ✅ |
| phpMyAdmin / DB UI | ✅ | — | ✅ | ✅ |
| Public share tunnel | ✅ | ✅ (Expose) | ✅ (Preview) | ✅ (Cloudflare) |
| One-click admin / magic login | — | — | — | ✅ |
| Log viewer | ✅ | ✅ (Pro) | ✅ | ✅ (per-site) |
| Xdebug | ✅ | ✅ | ✅ | ❌ |
| Site cloning | ✅ | — | — | ❌ |
| Blueprints / templates | ✅ | herd.yml | ✅ | ❌ |
| Change site URL (+ DB search-replace) | ✅ | — | ✅ | ❌ |
| Export / import site | ✅ | — | ✅ | ❌ |
| Cloud backup / push-to-host sync | ✅ | ✅ (Forge) | ✅ (.com / Pressable) | ❌ |
| Multisite support | ✅ | — | — | ❌ |
| AI / agentic coding | — | — | ✅ (Studio Code) | ❌ |
| Cross-platform (Windows / Linux) | ✅ | ✅ | ✅ | ❌ (macOS only) |

---

## Current WPHerd features (baseline)

The **Also in** tag names which competitors ship a comparable feature — useful for
spotting where WPHerd is already at parity and where it stands alone.

- Supervised-child service management: nginx, PHP-FPM, MySQL, dnsmasq (start/stop/restart, crash restart, status polling) — *Also in: Local, Herd, Studio*
- Add / remove local `.test` sites via a streamed multi-step pipeline — *Also in: Local, Herd, Studio*
- Multiple PHP versions: install (incl. EOL 8.0 / 7.4 via `shivammathur/php` tap), switch, update, per-site override, `php.ini` editing (single + apply-to-all) — *Also in: Local, Herd, Studio*
- WP management via WP-CLI: overview, plugins, themes, wp-config editor (managed + raw), admin users — *Also in: Local, Studio*
- Mailpit inbox (catch `mail()`, read / mark / delete, web UI) — *Also in: Local, Herd (Pro), Studio*
- Cloudflare share tunnels (install, start / stop / list) — *Also in: Local (Live Links), Herd (Expose), Studio (Preview)*
- One-click admin "magic login" — *WPHerd only*
- phpMyAdmin, open in browser / Finder / terminal, per-site HTTPS toggle — *Also in: Local, Studio*
- Per-site logs (view / clear) — *Also in: Local, Herd, Studio*
- dnsmasq + `/etc/resolver/test` setup, sudoers management, dependency checks, onboarding — *Also in: Local, Herd, Studio*

---

## Recommended roadmap

Each item carries a **Provided by** tag (the competitor(s) that already offer it, for
benchmarking) and a **Reference** link to that solution's documentation.

> **Workflow:** to build any of these, tell Claude the feature name (e.g. "develop
> _Xdebug integration_" or "implement feature 3, _Clone site_"). Claude will open the
> reference link to study how the competitor solves it, then implement the WPHerd
> equivalent against `electron/` + `src/`.

### Tier 1 — High-value, low-friction (fits current architecture directly)

1. **Xdebug integration** — toggle Xdebug per PHP version, auto-write config, one-click
   enable/disable. Fits `php.cjs` + `SitePhpSettings`.
   — *Provided by: Local, Herd, Studio*
   — Reference: [Local — Xdebug](https://localwp.com/help-docs/advanced/using-xdebug-within-local/) · [Studio — Xdebug](https://developer.wordpress.com/docs/developer-tools/studio/xdebug/)
2. **Change site URL** — rename domain with automatic WP-CLI `search-replace` across the
   DB + nginx vhost regen + `/etc/resolver` refresh.
   — *Provided by: Local, Studio*
   — Reference: [Local — import & domain search-replace](https://localwp.com/help-docs/getting-started/how-to-import-a-wordpress-site-into-local/) · [Studio — sync](https://developer.wordpress.com/docs/developer-tools/studio/sync/)
3. **Clone / duplicate site** — copy files + dump/restore DB + rewrite config + new vhost.
   A natural extension of the add-site pipeline.
   — *Provided by: Local*
   — Reference: [Local — blueprints & clone](https://localwp.com/help-docs/local-features/how-to-use-blueprints/)
4. **Export / Import site** — zip files + SQL dump into a portable archive; import to
   recreate. Support common migration-plugin formats (`.wpress` / All-in-One) for interop.
   — *Provided by: Local, Studio*
   — Reference: [Local — import/export](https://localwp.com/help-docs/getting-started/how-to-import-a-wordpress-site-into-local/) · [Studio — import & export](https://developer.wordpress.com/docs/developer-tools/studio/import-export/)
5. **Site Blueprints** — save a site's config (PHP version, plugins, themes, sample
   content) as a reusable template for one-click new sites.
   — *Provided by: Local, Herd (`herd.yml`), Studio*
   — Reference: [Local — blueprints](https://localwp.com/help-docs/local-features/how-to-use-blueprints/) · [Herd — herd.yml](https://herd.laravel.com/docs/macos/sites/herd-yaml)
6. **HTTPS certificate trust automation** — ✅ **Shipped.** Enabling HTTPS on a site runs
   mkcert's locally-trusted CA (`mkcert -install`, added to the Keychain) and mints a
   browser-trusted per-site cert; Settings shows a read-only CA-trust status row.
   — *Provided by: Local, Studio*
   — Reference: [Local — SSL & trust](https://localwp.com/help-docs/getting-started/ssl-in-local/)

### Tier 2 — Server/service depth (Herd-style breadth)

7. **Additional services** — optional MariaDB, PostgreSQL, Redis, Memcached, Meilisearch,
   extending the `procman.cjs` supervised-child model.
   — *Provided by: Herd (Pro)*
   — Reference: [Herd — services](https://herd.laravel.com/docs/macos/herd-pro-services/services)
8. **nginx ⇄ Apache hot-swap** — support both webservers per site.
   — *Provided by: Local*
   — Reference: [Local — features](https://localwp.com/features/)
9. **OpCache toggle & status** — surface OpCache config in PHP settings.
   — *Provided by: Local, Herd*
   — Reference: [Local — features](https://localwp.com/features/)
10. **WordPress Multisite** — subdomain / subdirectory network setup during site creation.
    — *Provided by: Local*
    — Reference: [Local — multisite](https://localwp.com/help-docs/advanced/wordpress-multisite-with-local/)
11. **Composer / Node (nvm) management** — bundle or detect Composer and Node version
    switching per site.
    — *Provided by: Herd*
    — Reference: [Herd — databases & services](https://herd.laravel.com/docs/macos/getting-started/databases) · [Herd docs](https://herd.laravel.com/docs)

### Tier 3 — Sharing, backup & deployment

12. **Persistent share links** — named/stable tunnel URLs, plus basic-auth protection and a
    QR code for mobile testing.
    — *Provided by: Local (Live Links)*
    — Reference: [Local — Live Links](https://localwp.com/live-links/)
13. **Webhook testing helpers** — documented Stripe/PayPal webhook endpoints over the tunnel.
    — *Provided by: Local*
    — Reference: [Local — features](https://localwp.com/features/)
14. **Backups + cloud sync** — scheduled local snapshots, plus optional push/pull to a host.
    Vendor-neutral equivalent: a generic SFTP/rsync deploy target or Git-based deploy.
    — *Provided by: Local (Cloud Backups), Herd (Forge deploy), Studio (.com / Pressable sync)*
    — Reference: [Studio — sync](https://developer.wordpress.com/docs/developer-tools/studio/sync/) · [Local — features](https://localwp.com/features/)

### Tier 4 — Pre-launch & quality tools (Local's toolbox)

15. **Link checker** — crawl the local site for broken links.
    — *Provided by: Local*
    — Reference: [Local — link checker](https://localwp.com/help-docs/local-features/link-checker/)
16. **Image optimizer** — offline bulk image compression.
    — *Provided by: Local*
    — Reference: [Local — image optimizer](https://localwp.com/help-docs/local-features/image-optimizer/)
17. **Instant / live reload** — auto-refresh browser on file change.
    — *Provided by: Local (Instant Reload)*
    — Reference: [Local — features](https://localwp.com/features/)
18. **Database GUI beyond phpMyAdmin** — optional Adminer or a lightweight built-in table browser.
    — *Provided by: Local, Studio (phpMyAdmin)*
    — Reference: [Studio — debugging & database](https://developer.wordpress.com/docs/developer-tools/studio/debugging/)

### Tier 5 — AI / differentiation (Studio Code territory)

19. **AI assistant panel** — conversational site management: run WP-CLI, create/edit theme
    & plugin files, capture screenshots, audit performance — backed by the Claude API.
    Studio Code defaults to Claude Sonnet/Opus, so this aligns well.
    — *Provided by: Studio (Studio Code)*
    — Reference: [Studio Code](https://developer.wordpress.com/docs/developer-tools/studio/studio-code/)

### Tier 6 — Reach

20. **Cross-platform** — Windows (and Linux) support. Large effort (Homebrew assumption,
    `execSync` service modules, dnsmasq/resolver, tray) but strategically significant.
    — *Provided by: Local, Herd, Studio*
    — Reference: [Studio — overview](https://developer.wordpress.com/studio/) · [Herd docs](https://herd.laravel.com/docs)

---

## Suggested sequencing

Ship **Tier 1** first — Xdebug, change URL, clone, export/import, and blueprints are the
features users switching *from* Local will immediately miss, and each maps cleanly onto the
existing `wordpress.cjs` / `php.cjs` / IPC pipeline. Plan toward **Tier 5** (AI assistant)
as the standout differentiator, since it plays to Claude's strengths and no competitor
except Studio has it yet.
