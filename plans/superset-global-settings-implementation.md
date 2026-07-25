# WPHerd global settings — implementation plan

Companion to `plans/superset-global-settings.md` (the analysis). That document says
_what_ to build and why; this one says _how_, in the order it should be built.

Reference implementation: `superset-sh/superset`,
`apps/desktop/src/renderer/routes/_authenticated/settings/**` and
`apps/desktop/src/shared/themes/**`.

---

## 0. Goal, non-goals, and the shape of the change

**Goal.** Turn `src/components/Settings.jsx` — one 491-line scroll with a trailing
Save button — into a routed, searchable, auto-saving settings surface, and fill it
with the global preferences WPHerd is missing.

**Non-goals.** Account / Organization / Teams / Billing / Hosts / Integrations
(Superset is multi-user cloud; WPHerd is single-user local). No Models section
until WPHerd itself calls a model. No v1/v2 variant gating.

**The three-place rule still applies.** Every setting that crosses the process
boundary touches `electron/ipc.cjs` (handler) → `electron/preload.cjs` (bridge
method, plus `VALID_EVENT_CHANNELS` for any new event) → a renderer component.
The plan below lists all three for each phase.

### Current state, precisely

| Thing            | Where                                                                                                                                                                                                               | Note                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Settings page    | `src/components/Settings.jsx`                                                                                                                                                                                       | 5 cards + one Save button                                                  |
| Persisted keys   | `settings.sitesDir`, `.defaultPhpVersion`, `.startAtLogin`, `.dbUser`, `.dbPassword`                                                                                                                                | via `get-settings` / `save-settings`, `ipc.cjs:1820-1855`                  |
| Orphan keys      | `settings.mailCatch` (toggled from `Mail.jsx:369`), `settings.onboardingComplete`                                                                                                                                   | never shown in Settings                                                    |
| Store            | `electron/store.cjs` `JsonStore`                                                                                                                                                                                    | dotted paths, atomic write, already sufficient                             |
| Theme            | `tailwind.config.js` `darkMode: 'media'`; `src/index.css` `@media (prefers-color-scheme: dark)`; `src/lib/theme.js` `terminalThemes`/`uiColors`; `src/lib/editorTheme.js` derives CodeMirror tags from the ANSI set | **no in-app override is possible today** — see Phase 5                     |
| PHP ini          | `php.cjs` `PHP_INI_SETTINGS` (per installed version) + `SITE_PHP_SETTINGS` (per site, via `fastcgi_param PHP_VALUE`)                                                                                                | both already exist; the gap is _defaults for new sites_, not the mechanism |
| Window close     | `main.cjs:60-64` hides to tray unconditionally                                                                                                                                                                      |                                                                            |
| Open file/folder | `shell.openPath` (`ipc.cjs:213`, `:1618`)                                                                                                                                                                           | no editor preference                                                       |
| Nav              | `Layout.jsx:23-32`, Settings is a single leaf route                                                                                                                                                                 |                                                                            |

---

## 1. Architecture decisions (settle these before Phase 1)

### 1.1 One generic settings channel, not one handler per setting

Superset gets a typed getter+setter per setting for free from tRPC. WPHerd would
pay for that in hand-written IPC. Instead:

```js
// electron/ipc.cjs
ipcMain.handle('settings-get-all', () => readSettings()); // resolved, with defaults
ipcMain.handle('settings-set', (_e, patch) => writeSettings(patch)); // shallow patch, validated
```

`writeSettings` validates the patch against a **schema declared in the main
process** (`electron/services/settings.cjs`, new), writes only known keys, runs any
`onChange` side effect, then broadcasts `settings-updated` with the full resolved
object to every window. Unknown keys are dropped, not persisted.

Keep the existing `get-settings` / `save-settings` handlers as thin aliases for one
release so nothing else in the renderer breaks mid-refactor.

### 1.2 The schema is the single source of truth

`electron/services/settings.cjs` exports:

```js
const SETTINGS = {
  'sites.dir': { type: 'path', default: wordpress.DEFAULT_SITES_DIR },
  'app.confirmOnQuit': { type: 'bool', default: true },
  'appearance.themeMode': {
    type: 'enum',
    values: ['system', 'light', 'dark'],
    default: 'system',
  },
  // …
};
```

Each entry: `{ type, default, values?, min?, max?, validate?, onChange? }`.
`onChange(value, ctx)` is where `app.setLoginItemSettings`, MySQL client re-init,
PHP conf.d rewrites, and nginx reloads hang. This replaces the growing `if
(typeof settings.x === 'string')` ladder in `save-settings`.

The renderer gets a **parallel registry** — `src/lib/settingsRegistry.js` — carrying
presentation only: `{ id, section, title, description, keywords[], control }`. That
is Superset's `SETTINGS_ITEMS` (`utils/settings-search/settings-search.ts`) minus
the variant gating. Search and section filtering read from it.

Two registries, deliberately: the main one guards persistence and side effects and
must not import React; the renderer one carries copy and cannot be trusted for
validation.

### 1.3 Auto-save, optimistic, with rollback

Superset's `BehaviorSettings.tsx` pattern: write local state immediately, fire the
mutation, roll back and toast on rejection. In WPHerd this is one hook:

```js
// src/lib/useSettings.js
const [settings, setSetting, pending] = useSettings();
setSetting('app.confirmOnQuit', false); // optimistic, persists, rolls back on error
```

It subscribes to `settings-updated` so a change made in the tray menu or another
window lands in the open Settings page. **The Save button is deleted.**

### 1.4 Routes, not cards

`/settings` becomes a layout route with its own sidebar and an `<Outlet />`,
mirroring Superset's `settings/layout.tsx` + `SettingsSidebar`. Sections are
deep-linkable (`/settings/appearance`), which also gives the tray menu and the
onboarding wizard somewhere specific to point.

Proposed nav (`SettingsSidebar.jsx`, groups as in Superset's `GeneralSettings.tsx`):

| Group     | Sections                                                                             |
| --------- | ------------------------------------------------------------------------------------ |
| Personal  | Appearance · Notifications                                                           |
| App       | General · Keyboard · Terminal · Agents · External Tools                              |
| WordPress | Sites · PHP · Database · Mail · Blueprints                                           |
| System    | Services · DNS & HTTPS · Permissions · Sharing · Experimental · Dependencies · About |

Every section page is `px-6 pb-6 max-w-[735px] mx-auto` and composes existing
`ui.jsx` primitives (`Card`, `Row`, `SectionLabel`, `Toggle`, `Button`,
`SegmentedTabs`). **No new card/row/button styling** — per `CLAUDE.md`, a new
button style means a new `.btn-*` variant, not inline classes.

### 1.5 One new shared primitive

`SettingsRow` in `ui.jsx`, wrapping `Row` with the control-on-the-right contract
and a `searchHidden` prop so a section can render only its matching rows. Superset
has the same component under `settings/components/SettingsRow`.

---

## Phase 1 — Settings shell (no behaviour change)

**Ship:** the routed shell with today's five cards moved in verbatim, auto-save,
zero new settings. This is the phase that makes every later phase cheap.

Files:

- `electron/services/settings.cjs` **new** — `SETTINGS` schema (only the five
  existing keys), `readSettings()`, `writeSettings(patch)`, `broadcast()`.
- `electron/ipc.cjs` — register `settings-get-all` / `settings-set`; rewrite
  `get-settings` / `save-settings` to delegate; move the `app.setLoginItemSettings`
  and MySQL re-init calls into `onChange`.
- `electron/preload.cjs` — `getAllSettings()`, `setSetting(key, value)`,
  `setSettings(patch)`; add `'settings-updated'` to `VALID_EVENT_CHANNELS`.
- `src/lib/useSettings.js` **new** — the hook from §1.3.
- `src/lib/settingsRegistry.js` **new** — entries for the existing settings only.
- `src/components/settings/SettingsLayout.jsx`, `SettingsSidebar.jsx` **new**.
- `src/components/settings/sections/{General,Database,Dns,Blueprints,Dependencies,About}.jsx`
  **new** — bodies lifted from `Settings.jsx` with the local `useState`/`handleSave`
  removed in favour of `setSetting`.
- `src/components/ui.jsx` — add `SettingsRow`.
- `src/App.jsx` — nest the section routes under `path="settings"`.
- `src/components/Settings.jsx` — delete once the sections are ported.

Tests (`test/`, vitest, main-process logic only per repo convention):

- `settings.test.cjs` — unknown key dropped; wrong type rejected; enum out of range
  rejected; `onChange` fires once per accepted key and not on rejection; defaults
  returned for unset keys; a rejected patch leaves the store untouched.

Acceptance: every control that exists today still works, changes persist without a
Save button, `/settings/database` deep-links, `npm run test && npm run lint` clean.

**Risk:** the silent-drop rule means a typo'd key persists nothing and says nothing.
`writeSettings` must return `{ ok, rejected: [{key, reason}] }` and the hook must
toast on non-empty `rejected` — otherwise this is a debugging trap.

---

## Phase 2 — Settings search

- `src/lib/settingsRegistry.js` — fill in `keywords[]` for every row (Superset's
  entries average ~9 keywords; match that density or search under-fires).
- `src/lib/settingsSearch.js` **new** — `matchCountsBySection(query)` and
  `visibleItems(section, query)`, ported from `getVisibleMatchCountBySection`.
- `SettingsSidebar.jsx` — search input, per-section match-count badges, sections
  with zero matches hidden.
- Each section page — accept `visibleItems` and gate rows through
  `isItemVisible(id, visibleItems)`.
- A `SearchResultsBanner` equivalent ("Showing results for … ✕").

Test: `settingsSearch.test.js` — title match, description match, keyword match,
case/whitespace insensitivity, empty query returns everything, a query matching
nothing returns zero sections.

Acceptance: typing "php" surfaces Sites (default version), PHP, and Dependencies,
and nothing else.

---

## Phase 3 — Tier-1 settings (the papercuts)

Each row = one schema entry + one registry entry + one `SettingsRow`. Grouped by
section:

**General**

- `app.confirmOnQuit` (bool, default `true`) — `main.cjs` `before-quit` shows a
  `dialog.showMessageBox` naming how many sites are running before it stops
  services. This is the highest-value single row in the plan: quitting currently
  takes every site down silently.
- `app.closeAction` (enum `tray|quit`, default `tray`) — read in the `main.cjs:60`
  `close` handler instead of the current unconditional `hide()`.
- `app.startAtLogin` — moved here from General/existing.

**Mail**

- `mail.catch` — the existing `settings.mailCatch`, finally visible in Settings.
  Migrate the key, keep `Mail.jsx`'s toggle wired to the same setter so both stay
  in sync through `settings-updated`.
- `mail.autoOpenInbox` (bool), `mail.smtpPort` / `mail.uiPort` (int, default
  1025 / 8025).

**External Tools** (new section)

- `tools.editor` (enum + custom command: VS Code, Cursor, PhpStorm, Sublime,
  Zed, custom) — new `electron/services/externalTools.cjs` resolving each to a
  binary (`code`, `cursor`, `pstorm`, `subl`, `zed`) with a `shell.openPath`
  fallback, and a "detected / not found" badge per option like Superset's
  provider status badges.
- `tools.browser` (enum: system default, or a specific installed browser) — used
  by `openSiteInBrowser`.
- `tools.terminalApp` (enum: Terminal, iTerm2, Warp, Ghostty) for "Open in
  Terminal".
- IPC: replace the bare `shell.openPath` at `ipc.cjs:213`/`:1618` with
  `externalTools.openPath(target, { kind })`.

**Sites**

- `sites.defaultWpVersion` (string, default `latest`), `sites.defaultLocale`,
  `sites.defaultAdminUser` / `.defaultAdminEmail` / `.defaultAdminPassword`,
  `sites.tld` (enum `test|localhost|local`, default `test` — **gated**: changing it
  requires the dnsmasq resolver for the new TLD, so the row must trigger the same
  admin flow as the DNS card and refuse to save if that is declined),
  `sites.httpsOnCreate` (bool), `sites.defaultPlugins` / `.defaultThemes`
  (string lists, applied by `wordpress.cjs` after `wp core install`).
- These feed `AddSiteModal.jsx` as prefills, not as hard overrides — the modal
  still lets a site deviate.

**PHP** — note the correction to the analysis doc: global php.ini settings _already_
exist per installed version (`PHP_INI_SETTINGS`) and per site
(`SITE_PHP_SETTINGS`). The actual gap is:

- `php.newSiteDefaults` (object keyed by `SITE_PHP_SETTINGS[].key`) — the values a
  newly created site starts with, instead of the hardcoded `default` in each entry.
- Surface "inherited from global" on `SitePhpSettings.jsx` rows still at default,
  which is Superset's global→project→host fallback pattern made visible.

**Services**

- `services.autoStart` (array of `nginx|php|mysql|mailpit`, default all) — read in
  `main.cjs` launch instead of starting everything.
- `services.ports` (`{ http: 80, https: 443, mysql: 3306 }`) — each with a
  port-in-use check on save; `nginx.cjs` templates and `mysql.cjs` read from here.
- `services.logRetentionDays` (int, default 14) + `services.logMaxSizeMb` — a prune
  pass in `logs.cjs` on launch.

**Notifications**

- `notifications.enabled`, `notifications.sound` (id), `notifications.volume`
  (0–100), `notifications.onlyWhenBackgrounded` (bool). Fired for the flows that
  already stream progress: `site-create-progress`, `site-clone-progress`,
  `site-import-progress`, `site-export-progress`, `blueprint-save-progress`.
  Ship 3–4 bundled sounds under `assets/sounds/`, previewable from the row, plus
  custom-file import (Superset's ringtone list, minus the ringtone count).

Tests: schema validation for each new type (port range, enum, path exists);
`externalTools` resolution with a stubbed `which`; log prune boundary conditions.

---

## Phase 4 — Terminal presets, agents, sessions

**Terminal section**

- `terminal.presets` — `[{ id, name, description, cwd, commands[], siteScoped }]`,
  Superset's `PRESET_COLUMNS` (`settings/presets/types.ts`) plus a `commands`
  array. WPHerd-native seeds: `wp db cli`, `wp cron event run --due-now`,
  `npm run dev` in the active theme directory, `tail -f` the site's error log.
- `terminal.quickAdd` — which presets appear in the site page's launcher.
- `terminal.scrollback` (int), `terminal.backgroundSessionCap` (int) — Superset's
  `TERMINAL_BACKGROUND_LIMIT`, which maps directly onto `agents.cjs`'s session
  buffers.
- Sessions list: `agents.cjs` already tracks sessions per site; render them with
  site, agent, uptime and a kill button (Superset's `SessionsSection`).

**Agents section** — `electron/services/agents.cjs` currently hardcodes four agents
(`claude`, `codex`, `gemini`, `opencode`, lines 22–40).

- `agents.enabled` (array of ids) — filters `listAgents()`.
- `agents.commands` (`{ [id]: { command, promptCommand } }`) — overrides the
  built-in launch command.
- `agents.custom` (array of user-defined `{ id, name, command }`).
- `agents.taskPrompts` — templates with variables (`{site}`, `{path}`, `{url}`),
  Superset's `AGENTS_TASK_PROMPTS`.

Keep the built-ins as defaults so an empty config behaves exactly as today.

---

## Phase 5 — Appearance: themes and typography

**This is the phase with a repo-wide prerequisite.** `tailwind.config.js` is
`darkMode: 'media'` and `src/index.css` flips tokens inside
`@media (prefers-color-scheme: dark)`. An in-app override is impossible without
changing that. Order matters:

1. **Switch to a class strategy.** `darkMode: 'class'` (or
   `['class', '[data-theme="dark"]']`), move the `@media` block to a
   `:root[data-theme="dark"]` selector, and have a small bootstrap in `main.jsx`
   stamp `data-theme` on `<html>` from the persisted setting, falling back to
   `prefers-color-scheme` when the mode is `system`. `CLAUDE.md` notes the app has
   exactly one `dark:` variant (`dark:bg-input/60`), so the blast radius is the CSS
   file and that one utility — verify with a grep before starting.
2. **Then** `appearance.themeMode` (`system|light|dark`) +
   `appearance.lightThemeId` / `appearance.darkThemeId` — Superset's System option
   picks _which_ light and _which_ dark theme, each row showing a swatch.
3. **Promote the palettes into named themes.** `src/lib/theme.js` becomes
   `src/lib/themes/{ember,light,…}.js`, each exporting Superset's `Theme` shape:
   `{ id, name, type, ui, terminal?, editor? }`. `terminal` is the existing
   `terminalThemes.dark/.light` (bg, fg, cursor, cursorAccent, selection, 8 ANSI +
   8 bright). `editor` stays **optional and derived** — `editorTheme.js` already
   builds CodeMirror tags from the ANSI set, which is exactly Superset's fallback.
   `uiColors` becomes the `ui` block. Ship Ember (dark, default) + Light to start;
   a third (Monokai-equivalent) proves the abstraction.
4. **Custom theme import** — `appearance.customThemes`, a JSON file picker with a
   256 KB cap and a parse/validate step (`parseThemeConfigFile`), landing in a
   "Custom" group in the same dropdown. Reject unknown top-level keys; require
   `id`, `name`, `type`, `ui`.

**Typography** — two independent blocks, exactly Superset's split:

| Terminal                                 | Editor                         |
| ---------------------------------------- | ------------------------------ |
| `appearance.terminal.fontFamily`         | `appearance.editor.fontFamily` |
| `.fontSize` (int)                        | `.fontSize` (int)              |
| `.lineHeight` (float)                    | `.lineHeight` (float)          |
| `.letterSpacing` (float)                 | `.letterSpacing` (float)       |
| `.fontWeight` (int)                      | `.fontWeight` (int)            |
| `.ligatures` (bool)                      | `.ligatures` (bool)            |
| `.minimumContrast` (float)               | —                              |
| `.cursorStyle` (`block\|bar\|underline`) | —                              |
| `.cursorBlink` (bool)                    | —                              |

Font family is a combobox over a probed list — port `useSystemFonts`: a curated
Nerd Font list, then well-known monos (JetBrains Mono, Fira Code, Menlo, Iosevka,
Geist Mono, …), categorised Nerd / Mono / Other, plus runtime faces like SF Mono on
macOS, with a free-typed family and a "font not found" banner. Each block renders a
live preview surface. Defaults come from the existing `MONO_STACK`.

Consumers: `Terminal.jsx` (xterm options), `CodeEditor.jsx` (`editorMetrics` in
`editorTheme.js`), `SiteLogs.jsx`.

Tests: theme JSON validation (missing `ui`, bad `type`, oversize file); font-weight
override mapping (Superset has `toFontWeightOverride.test.ts` — port it);
`data-theme` resolution for all three modes against both system appearances.

---

## Phase 6 — Keyboard, Permissions, Sharing, Experimental

**Keyboard** — a shortcut registry in the renderer, click-to-record rebinding,
conflict detection with Superset's "would you like to reassign it?" prompt, and
reset-to-default. Persist as `keyboard.bindings` (`{ commandId: accelerator }`).
Start by cataloguing what WPHerd already binds (`Terminal.jsx`,
`TerminalSearchBar.jsx`, `FileExplorer.jsx`) rather than inventing new commands.

**Permissions** (macOS-only section, hidden elsewhere like Superset's `macOnly`) —
status + "Open System Settings" deep link for Full Disk Access (sites under
`~/Documents`/iCloud) and Local Network (`.test` resolution), alongside the
existing sudoers row from `sudoers.cjs`. Status is best-effort probing; never claim
"granted" without evidence.

**Sharing** — `cloudflared.cjs` already exists. Global defaults for tunnels:
`sharing.autoExpireMinutes`, `sharing.requireBasicAuth`,
`sharing.allowedSites` (allow-list). Superset's
`SECURITY_EXPOSE_HOST_SERVICE_VIA_RELAY` is the analogue, and the same caution
applies: exposing a local dev site to the internet is outward-facing, so the row
copy must say so plainly and default to off.

**Experimental** — `experimental.*` booleans with an "early access, may break"
banner. Populate only when there is something to gate.

---

## Phase 7 — Polish

- Tray menu → deep links into specific sections.
- Onboarding wizard hand-off → `/settings/dependencies`.
- "Copy diagnostics" on About (platform, brew prefix, versions, service states) —
  scrub `dbPassword` and any custom agent commands before copying.
- "Open data folder", "Reset app data" (typed confirmation; it deletes
  `wpherd-data.json` and blueprints), "Check for updates".
- `docs/features/FEATURES.md` update.

---

## Store schema summary

All new keys are namespaced; the five legacy flat keys migrate once on first launch
(`store.get('settings.sitesDir')` → `settings.sites.dir`, etc.) with the old keys
left in place for one release so a downgrade doesn't lose data.

```
settings.app.{confirmOnQuit,closeAction,startAtLogin}
settings.appearance.{themeMode,lightThemeId,darkThemeId,customThemes}
settings.appearance.terminal.{fontFamily,fontSize,lineHeight,letterSpacing,fontWeight,ligatures,minimumContrast,cursorStyle,cursorBlink}
settings.appearance.editor.{fontFamily,fontSize,lineHeight,letterSpacing,fontWeight,ligatures}
settings.notifications.{enabled,sound,volume,onlyWhenBackgrounded}
settings.tools.{editor,editorCustomCommand,browser,terminalApp}
settings.terminal.{presets,quickAdd,scrollback,backgroundSessionCap}
settings.agents.{enabled,commands,custom,taskPrompts}
settings.sites.{dir,defaultWpVersion,defaultLocale,defaultAdminUser,defaultAdminEmail,defaultAdminPassword,tld,httpsOnCreate,defaultPlugins,defaultThemes}
settings.php.{defaultVersion,newSiteDefaults}
settings.db.{user,password,charset,collation}
settings.mail.{catch,autoOpenInbox,smtpPort,uiPort}
settings.services.{autoStart,ports,logRetentionDays,logMaxSizeMb}
settings.sharing.{autoExpireMinutes,requireBasicAuth,allowedSites}
settings.keyboard.bindings
settings.experimental.*
```

`settings.dbPassword` and `settings.sites.defaultAdminPassword` stay in the plain
JSON store as they are today. Moving them to the macOS Keychain is a separate,
worthwhile change — call it out, don't smuggle it into this plan.

---

## IPC contract

| Channel                  | Direction | Payload                                                  |
| ------------------------ | --------- | -------------------------------------------------------- |
| `settings-get-all`       | invoke    | → resolved settings object                               |
| `settings-set`           | invoke    | `{ [key]: value }` → `{ ok, rejected: [{key, reason}] }` |
| `settings-updated`       | event     | full resolved settings (whitelist in `preload.cjs`)      |
| `settings-reset-section` | invoke    | `section` → `{ ok }`                                     |
| `list-system-fonts`      | invoke    | → `[{ family, category }]` (Phase 5)                     |
| `import-theme-file`      | invoke    | → `{ ok, theme }` or `{ ok: false, error }` (Phase 5)    |
| `open-system-settings`   | invoke    | `pane` (Phase 6)                                         |

---

## Test plan

Vitest covers main-process logic (repo convention — `test/` covers
`electron/services`), so:

- `settings.test.cjs` — schema validation, unknown-key drop, `onChange` dispatch,
  defaults, rejection leaves store untouched, legacy-key migration is idempotent.
- `externalTools.test.cjs` — binary resolution and fallback.
- `themes.test.js` — theme JSON parse/validate, size cap, mode resolution.
- `settingsSearch.test.js` — the matching cases from Phase 2.
- Manual smoke per phase: change every row, quit, relaunch, confirm persistence;
  toggle system appearance mid-session with `themeMode: system`.

---

## Sequencing

Phases 1 → 3 are the ones that change a user's day. 1 and 2 are pure refactor plus
scaffolding and should land as separate PRs. 3 is naturally splittable by section
(General+Mail, External Tools, Sites+PHP, Services, Notifications) and each split
is independently shippable. 4, 5 and 6 are independent of each other and can land
in any order once 1 is in — except that **Phase 5 must start with the
`darkMode: 'class'` migration**, which touches `index.css` repo-wide and should not
share a PR with the theme picker itself.
