# Development Plan — WordPress Multisite

**Roadmap:** Tier 2 #10 (`docs/features/FEATURES.md`) · _Provided by: Local_
**Reference:** [Local — multisite](https://localwp.com/help-docs/advanced/wordpress-multisite-with-local/)

## Overview & goals

Create WordPress Multisite networks — **subdirectory** (`site.test/blog2/`) and
**subdomain** (`blog2.site.test`) — from the Add Site wizard, with correct nginx
rewrites, wildcard DNS/certs for subdomain mode, and multisite-aware import/export.
Local supports both modes at creation time; that's the parity target.

Local WPHerd advantages already in place: dnsmasq resolves `*.test` wildcard (any
subdomain of a `.test` site already points at 127.0.0.1 — no extra DNS work), and
`mkcert` can mint wildcard SANs.

## Architecture & approach

Multisite is three coordinated changes: (1) `wp core multisite-install` instead of
`wp core install` in the creation pipeline, (2) multisite constants in `wp-config.php`,
(3) an nginx vhost variant with multisite rewrite rules (+ wildcard `server_name` and
wildcard cert for subdomain mode). Everything else (magic login, tunnels, clone,
change-URL) needs auditing for multisite assumptions but mostly works since a network
shares one DB and one docroot.

## Main-process work

1. **`electron/services/wordpress.cjs` — creation pipeline** (`createWordPressSite`):
   - Accept `siteData.multisite: { enabled: true, mode: 'subdirectory' | 'subdomain' }`.
   - Step 5 branches: `wp core multisite-install --url=... --title=...
     --admin_user/... --skip-email` plus `--subdomains` when mode is subdomain.
     WP-CLI writes the `MULTISITE`, `SUBDOMAIN_INSTALL`, `DOMAIN_CURRENT_SITE`, etc.
     constants into `wp-config.php` itself — verify and, if a WP version doesn't,
     follow up with `wp config set --raw` calls (same helper used by
     `WP_CONFIG_SETTINGS`).
   - Return `multisite: {enabled, mode}` on the site object.
2. **`electron/services/nginx.cjs` — `generateSiteConfig(site)`**:
   - When `site.multisite.enabled`, emit the canonical WP multisite nginx rules:
     - Both modes: `wp-admin` trailing-slash redirect, static/`wp-includes`
       pass-through.
     - **Subdirectory:** the `if (!-e $request_filename)` rewrites —
       `rewrite /wp-admin$ .../wp-admin/ permanent;`,
       `rewrite ^(/[^/]+)?(/wp-.*) $2 last;`, `rewrite ^(/[^/]+)?(/.*\.php) $2 last;`.
     - **Subdomain:** `server_name <domain> *.<domain>;` (extend the existing
       `aliases` emission; sanitization already rejects injection chars — allow the
       literal `*.` prefix here).
   - Keep it in the same pure function so it stays vitest-testable.
3. **Certificates (subdomain mode):** extend `siteops.mintCert(domain)` /
   `mkcert.generateCert` to accept extra SANs and mint `domain` + `*.domain` when the
   site is a subdomain network. Subdirectory mode needs no cert change.
4. **Site ops audit** (`electron/services/siteops.cjs`):
   - **Import:** today `isMultisiteDump()` *rejects* multisite SQL at
     `siteops.cjs:337` and `inspectArchive` warns on multisite `.wpress`. Phase 3
     relaxes this: detect multisite from the dump (`wp_blogs` / `MULTISITE` in
     wp-config), import, then run `wp search-replace --network` for URL rewrites, and
     write the multisite vhost. Until then the guards stay (documented limitation).
   - **Change URL / clone:** use `--network` flag on `search-replace` for multisite
     sites; subdomain networks also need `wp_blogs`/`wp_site` domains updated
     (search-replace covers them with `--network` + `--all-tables`).
   - **Magic login / tunnel mu-plugins:** verify `ensureMagicLoginMuPlugin` works
     network-wide (mu-plugins are network-global — should be fine; test).
5. **Deletion:** unchanged — one DB, one docroot, one (wildcard) vhost.

## IPC / preload

Minimal: `create-site` handler already passes `siteData` through — extend validation to
accept the `multisite` object. No new channels (progress stays on
`site-create-progress`).

## Renderer work

- **`src/components/AddSiteModal.jsx`:** an "Advanced" disclosure (or a step in the
  existing `StepIndicator` flow) with a Multisite toggle and, when on, a mode radio —
  Subdirectory (recommended) / Subdomain. Copy explains the difference and that mode
  can't be changed later.
- **`src/components/SiteDetail.jsx` Overview:** "Multisite: Subdomain network" info row
  (in the existing `rows` array); "Network Admin" quick action opening
  `/wp-admin/network/`.
- **`src/components/WpOverview.jsx` / plugins / themes:** WP-CLI plugin/theme commands
  against a network need `--network` awareness for activate (network-activate vs
  per-site). v1: show a "network" badge and use `wp plugin activate --network`;
  per-subsite management is out of scope.

## Data model

`site.multisite: { enabled: boolean, mode: 'subdirectory' | 'subdomain' }` — absent on
existing sites (treated as disabled). Healed in the `get-sites` read like other
optional fields.

## Testing

- Unit (vitest): `generateSiteConfig` multisite matrix (mode × https) asserting the
  rewrite blocks and wildcard `server_name`; sanitization still rejects hostile input;
  mintCert SAN args.
- Manual: create both network types; create a second subsite in each; verify subsite
  loads, wp-admin works on subsite, uploads (`/files/` path on subdirectory) serve;
  HTTPS subdomain subsite shows trusted wildcard cert; magic login on main site;
  export a multisite (Phase 3: reimport it).

## Phased milestones

1. **Phase 1:** subdirectory networks — pipeline branch, vhost rules, wizard toggle,
   Overview row. (No cert/DNS changes needed.)
2. **Phase 2:** subdomain networks — wildcard `server_name`, wildcard cert SAN,
   Network Admin action, plugin/theme `--network` handling.
3. **Phase 3:** multisite import/export/clone/change-URL support (drop the
   `isMultisiteDump` rejection, `--network` search-replace), convert an existing
   single site to multisite (stretch — Local doesn't offer this either).

## Risks & open questions

- **Tunnels + subdomain networks:** a Cloudflare tunnel exposes one hostname; subdomain
  subsites won't resolve over it. Document as a limitation (Local has the same issue).
- **`.wpress` multisite imports** are explicitly out of scope (All-in-One gates
  multisite behind paid extensions; archives vary) — keep the existing warning.
- **Subdirectory `/files/` rewrites** for legacy `ms-files` are omitted (modern WP ≥3.5
  doesn't use them) — note in code comment.
