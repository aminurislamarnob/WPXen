# Development Plan — Backups & Cloud Sync (Git Deploy, Google Drive, Dropbox)

**Roadmap:** Tier 3 #14 (`docs/features/FEATURES.md`) · _Provided by: Local (Cloud
Backups), Herd (Forge deploy), Studio (.com/Pressable sync)_
**References:** [Local — features](https://localwp.com/features/) · [Studio — sync](https://developer.wordpress.com/docs/developer-tools/studio/sync/)

## Overview & goals

Three capabilities, shipped as phases on one foundation:

- **A. Local backups** — manual + scheduled per-site snapshots (files + DB) with
  retention and one-click restore.
- **B. Git deploy** — push a site's files (optionally + DB dump) to a git remote
  (GitHub/GitLab/any), for versioning or a pull-based deploy workflow.
- **C. Cloud sync** — upload/download backup archives to the user's **Dropbox** and
  **Google Drive** via OAuth.

The snapshot engine already exists: `siteops.exportSite` (DB dump + manifest + files →
zip), `siteops.importSite` (full restore with rollback ledger), and `blueprints.cjs`
proves the "store-tracked list of zips in `userData/`" pattern. Backups are largely a
scheduling + retention + provider layer on top.

## Phase A — Local scheduled backups

### Main process

1. **`electron/services/backups.cjs`** (new), modeled directly on `blueprints.cjs`:
   - Storage: `userData/backups/<siteId>/<ISO-timestamp>.zip`; metadata array in
     `store.get('backups')` — `{id, siteId, createdAt, sizeBytes, note,
     trigger: 'manual'|'scheduled', wpVersion, phpVersion}`.
   - `createBackup(store, site, {note, trigger}, onProgress)` → wraps
     `siteops.exportSite` (already streams `{step,message}`).
   - `restoreBackup(store, backupId, onProgress)` → **restore in place**: safest v1 is
     restore-as-new-site via `siteops.importSite` under a temp domain? No — parity
     says in-place. Implement in-place restore as: create a safety snapshot first,
     then reuse `importSite`'s internals against the existing site (drop/recreate DB
     via `mysql`, replace files, keep domain/vhost). Extract the shared pieces from
     `importSite` rather than duplicating.
   - `listBackups(store, siteId)` (self-heal orphaned records like `listBlueprints`),
     `deleteBackup`, `applyRetention(store, siteId)` (keep last N + optional max age,
     from settings).
2. **Scheduler** in `ipc.cjs`/new `scheduler.cjs`: a self-rescheduling `setTimeout`
   chain (exact `startStatusPoller` pattern) that wakes hourly, finds sites whose
   `backupSchedule` (`daily`/`weekly`, per-site or global default) is due
   (`lastBackupAt` in store), and runs `createBackup` sequentially. Skips if MySQL
   isn't running; never overlaps (single in-flight flag).

### IPC / preload / UI

- Handlers: `list-backups`, `create-backup`, `restore-backup`, `delete-backup`,
  `get-backup-settings`, `set-backup-settings`. Progress channels
  `backup-progress`, `restore-progress` (whitelist in `preload.cjs`).
- **`SiteDetail.jsx`:** new flat NAV item **"Backups"** → `SiteBackups.jsx` panel:
  Back Up Now button, table of snapshots (date, size, note, trigger) with
  Restore / Download(reveal in Finder) / Delete row actions, schedule select
  (Off / Daily / Weekly), `<ProgressLog>` during runs. Restore confirms with a modal
  (destructive).
- **`Settings.jsx`:** "Backups" section — default schedule, retention (keep last N),
  total disk usage + "Reveal backups folder".

### Store

`backups` (top-level array), `settings.backups: {defaultSchedule, retainCount}`,
`site.backupSchedule` override, `site.lastBackupAt`.

## Phase B — Git deploy

1. **`electron/services/gitdeploy.cjs`** (new):
   - Preflight: `git --version` (Xcode CLT ships git; add a deps row if missing).
   - `configure(site, {remoteUrl, branch})` — `git init` in `site.path` if needed,
     write a WPHerd-managed `.gitignore` (excludes `wp-config.php` secrets? No —
     exclude nothing by default except `node_modules`; include a commented template),
     set `wpherd` remote.
   - `deploy(site, {message, includeDb}, onProgress)` — optional
     `mysql.dumpDatabase` → `.wpherd/database.sql`, then `git add -A`, `commit`,
     `push wpherd <branch>`, streaming stdout/stderr lines. Array-argv spawn, never
     shell. Auth relies on the user's existing git credential setup (SSH keys /
     credential helper) — WPHerd stores **no** git credentials in v1.
   - `getStatus(site)` — configured?, last deploy, dirty file count.
2. **IPC/UI:** handlers `get-git-deploy-status`, `configure-git-deploy`,
   `run-git-deploy`; channel `deploy-progress`. UI lives as a "Deploy" card inside the
   `SiteBackups.jsx` panel (or its own NAV child under a "Backup & Deploy" group):
   remote URL + branch form (`.form-input`), Deploy button, streamed log.
3. **Store:** `site.gitDeploy: {remoteUrl, branch, includeDb, lastDeployAt}`.

## Phase C — Cloud sync (Dropbox first, then Google Drive)

1. **Provider adapter interface** `electron/services/cloud/provider.cjs`:
   `{id, name, isConnected(), connect(onProgress), disconnect(), upload(localPath,
   remoteName, onProgress), list(), download(remoteName, localPath), remove(remoteName)}`
   — so Drive/Dropbox (and later S3) are plug-ins. Files live under an app folder
   (`/Apps/WPHerd/` on Dropbox; `appDataFolder`/named folder on Drive).
2. **OAuth 2 + PKCE loopback flow** (main process, no client secret):
   `shell.openExternal(authUrl)` + a one-shot `http.createServer` on
   `127.0.0.1:<random port>` catching the redirect; exchange code for tokens with
   Node's built-in `fetch`. **Tokens encrypted with Electron `safeStorage`**
   (`safeStorage.encryptString` → base64 in store under `settings.cloud.<provider>`;
   never plaintext). Refresh-token rotation handled per provider.
   - **Dropbox:** single OAuth app, `token_access_type=offline`, App Folder
     permission — simplest; ship first.
   - **Google Drive:** requires a Google Cloud project + OAuth consent screen
     (external prerequisite — needs verification for >100 test users; flag to
     maintainer). `drive.file` scope only.
3. **Sync logic** in `backups.cjs`: `uploadBackup(backupId, providerId, onProgress)`
   (chunked upload — Dropbox upload sessions / Drive resumable — for multi-GB zips),
   `syncEnabled` per site auto-uploads after each scheduled backup; `pull` lists
   remote archives and downloads into the local backups dir (restore then goes
   through the normal path). Remote retention mirrors local `retainCount`.
4. **IPC/UI:** handlers `cloud-connect`, `cloud-disconnect`, `cloud-status`,
   `upload-backup`, `list-remote-backups`, `download-remote-backup`; channel
   `cloud-sync-progress`. UI: provider connect cards in the Settings "Backups"
   section (Connected as `<account email>` / Connect button); per-backup "Upload to…"
   action + cloud icon on synced rows in `SiteBackups.jsx`; per-site "auto-upload"
   toggle.

## Testing

- Unit (vitest): retention pruning logic, schedule due-date math, backup metadata
  self-healing, gitignore/remote idempotency, PKCE verifier/challenge generation,
  provider adapter with a mocked fetch (Dropbox chunk sequencing).
- Manual: create/restore a backup on a real site (verify content + plugins after
  restore); schedule daily and fake `lastBackupAt` to trigger; git deploy to a
  scratch GitHub repo over SSH; Dropbox connect → upload → delete local → download →
  restore; token refresh after expiry; app relaunch keeps connections.

## Phased milestones

1. **A1:** manual per-site backup + restore + list UI.
2. **A2:** scheduler + retention + Settings section.
3. **B:** git deploy.
4. **C1:** Dropbox (OAuth, upload/download, auto-upload).
5. **C2:** Google Drive (behind the same adapter).

## Risks & open questions

- **In-place restore is destructive** — always take an automatic pre-restore safety
  snapshot; modal must state what will be overwritten.
- **Large archives**: exports of media-heavy sites can be GBs — chunked/resumable
  uploads are mandatory, and scheduled backups should be skippable on low disk
  (check free space before `exportSite`).
- **Google app verification** is an organizational task, not a code task — Dropbox-
  first ordering exists precisely to decouple shipping from it.
- **Secrets:** `safeStorage` availability check on first use (fails on some
  keychain-less setups) — fall back to refusing to connect rather than plaintext.
- **wp-config in git**: pushing `wp-config.php` (contains local DB creds only, but
  also salts) — default the WPHerd `.gitignore` to exclude it and document why.
