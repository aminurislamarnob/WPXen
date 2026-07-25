# Superset settings → WPHerd global settings

A read of Superset's settings surface (`superset-sh/superset`,
`apps/desktop/src/renderer/routes/_authenticated/settings/**`) and what of it WPHerd
should adopt as **global settings**.

WPHerd's settings today live in one scrolling page,
`src/components/Settings.jsx` (491 lines), with five cards — General, Database,
DNS & Permissions, Blueprints, Dependencies, About — and a single trailing
**Save** button. Persisted keys are only `settings.sitesDir`,
`settings.defaultPhpVersion`, `settings.startAtLogin`, `settings.dbUser`,
`settings.dbPassword`, plus `settings.mailCatch` / `settings.onboardingComplete`
that are written from elsewhere and never surfaced in Settings.

---

## 1. How Superset structures settings

Five structural decisions matter more than any individual toggle.

**Routed, sidebar-navigated sections.** `settings/layout.tsx` renders
`SettingsSidebar` + an outlet; every section is its own route
(`/settings/appearance`, `/settings/terminal`, …). `GeneralSettings.tsx` groups
them under four headers:

| Group             | Sections                                                                 |
| ----------------- | ------------------------------------------------------------------------ |
| Personal          | Account · Appearance · Notifications                                     |
| Editor & Workflow | General · Keyboard · Git & Worktrees · Agents · Terminal · Links · Models |
| Organization      | Organization · Teams · Projects · Hosts · Integrations · Billing · API Keys |
| System            | Security · Permissions (macOS only) · Experimental                        |

Platform-only sections are filtered at render (`macOnly`), so the nav never shows
a dead route.

**A searchable settings registry.** `utils/settings-search/settings-search.ts`
(1556 lines) declares every individual setting as
`{ id, section, title, description, keywords[] }` — ~60 entries. The sidebar
search filters *sections* by match count and each section renders only its
matching rows (`isItemVisible(SETTING_ITEM_ID.X, visibleItems)`). The same
registry carries a `SETTING_ITEM_VARIANT` map (`v1` / `v2` / `shared`) so a
setting can be hidden per UI variant without touching the page.

**No Save button.** Every row is an independent tRPC query + optimistic mutation
(`BehaviorSettings.tsx` — `onMutate` writes the cache, `onError` rolls back,
`onSettled` invalidates). Changing a control *is* the commit.

**Global default → per-entity override.** Worktree location exists at user level
(`GIT_WORKTREE_LOCATION`), per project (`PROJECT_WORKTREE_LOCATION`), and per host
(`HOST_WORKTREE_LOCATION`), each falling back to the level above.

**A shared row/list vocabulary.** `components/SettingsRow`, `SettingsListSidebar`
(filter input + grouped nav + empty/no-match states), `ClickablePath`,
`SearchResultsBanner`. Nothing is hand-rolled per page.

---

## 2. Superset's actual setting inventory (the parts with a WPHerd analogue)

- **Appearance** — theme picker (System / named light / named dark, each with a
  colour swatch; System splits into *light theme* + *dark theme* pickers), custom
  theme import from JSON (256 KB cap), markdown render style, and two typography
  blocks (editor, terminal): font family combobox, size, line height, letter
  spacing, weight, ligatures, plus terminal-only minimum contrast, cursor style
  (block/bar/underline) and cursor blink — with live preview surfaces.
- **Notifications** (`ringtones`) — play-sound-on-task-complete toggle, ringtone
  list with durations and previews, custom audio import, volume dropdown.
- **General** (`behavior`) — confirm before quitting, file open mode
  (split pane / new tab), resource monitor (CPU + memory in the top bar),
  open links in the in-app browser.
- **Keyboard** — full shortcut list, click-to-record rebinding, conflict
  detection with a "reassign?" prompt.
- **Terminal** — presets (name / description / working directory / command list),
  quick-add templates, link behaviour, background-terminal memory limit, and a
  daemon/sessions section listing live sessions. (`/settings/presets` now just
  redirects into Terminal.)
- **Agents** — which agents appear in launchers, per-agent launch commands
  (no-prompt and prompt variants), task-prompt templates.
- **Links** — how file links, URL links, sidebar file rows and ports open.
- **Models** — Anthropic / OpenAI auth via OAuth *or* API key, a status badge
  (connected / needs auth), and a collapsed **Advanced** block for auth token,
  base URL and extra env vars, saved on blur.
- **Permissions** (macOS) — Full Disk Access, Accessibility, Microphone, Apple
  Events, Local Network: status + deep link to System Settings.
- **Security / Experimental** — relay exposure toggle; feature flags.
- **Project** — name, path, scripts, branch prefix, worktree location, env vars.

---

## 3. What WPHerd should take

### Tier 0 — structure (do this first; everything else lands cheaper afterwards)

1. **Split Settings into routed sections with a settings sidebar.** Suggested
   groups, WPHerd-flavoured:
   - *Personal* — Appearance · Notifications
   - *App* — General · Keyboard · Terminal · Agents · External Tools
   - *WordPress* — Sites · PHP · Database · Mail · Blueprints
   - *System* — Services · DNS & HTTPS · Permissions · Sharing · Experimental ·
     Dependencies · About
2. **Kill the Save button.** Persist per row on change (WPHerd's `JsonStore`
   already supports dotted-path `set`, and `save-settings` already re-inits the
   MySQL client on write). One `settings-updated` event back to the renderer keeps
   other panes in sync.
3. **Build the setting registry** — `{ id, section, title, description, keywords }`
   — and a search box that filters sections + rows. WPHerd has enough settings to
   justify it the moment tier 1 lands.
4. **Adopt the global-default → per-site-override pattern explicitly.** WPHerd
   already has `PhpSettings.jsx` and `SitePhpSettings.jsx`; make the global page
   the documented default source and show "inherited from global" on the site page.

### Tier 1 — settings WPHerd is missing and clearly needs

| Setting                                       | Section          | Why                                                                                        |
| --------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| **Confirm before quitting**                   | General          | Quitting stops nginx/PHP-FPM/MySQL for every site (`procman`). Superset's `BEHAVIOR_CONFIRM_QUIT` verbatim. |
| **Close button: hide to tray / quit**         | General          | `main.cjs` hard-codes hide-to-tray; make it a preference.                                    |
| **Catch outgoing mail**                       | Mail             | `settings.mailCatch` already exists in the store but is only reachable from the Mail page.    |
| **External editor / browser / terminal app**  | External Tools   | Superset's Links section. WPHerd calls `shell.openPath` today, so "Open in editor" is whatever macOS decided. Offer VS Code / Cursor / PhpStorm / Sublime / custom command, plus which browser opens a site. |
| **New-site defaults**                         | Sites            | Default WP version + locale, admin user/email/password, TLD, "enable HTTPS on create", multisite, and a default plugin/theme list. This is Superset's *project scripts / env vars* idea applied to site scaffolding. |
| **Global PHP defaults**                       | PHP              | `memory_limit`, `max_execution_time`, `upload_max_filesize`, `post_max_size`, Xdebug — global default, per-site override. |
| **Service auto-start + ports**                | Services         | Which of nginx / PHP-FPM / MySQL / Mailpit start on launch; nginx 80/443, MySQL 3306, Mailpit 8025. Currently implicit in `main.cjs`. |
| **Log retention / rotation**                  | Services         | `logs.cjs` writes without a documented cap.                                                  |
| **Notification sound on long tasks**          | Notifications    | Site create / clone / import / blueprint restore all take minutes. Superset's ringtone model (toggle + sound + volume) fits directly. |

### Tier 2 — high value, larger builds

- **Appearance section — colour scheme.** WPHerd deliberately follows the macOS
  appearance today (`darkMode: 'media'`, no switcher). Adopt Superset's shape
  rather than a plain toggle: **System / Light / Dark**, where System exposes
  *which* light theme and *which* dark theme, each row showing a `ThemeSwatch`
  preview.

  The important part is that **one theme drives every surface**. Superset's
  `Theme` (`shared/themes/types.ts`) is `{ id, name, author, type: 'dark'|'light',
  ui: UIColors, terminal?: TerminalColors, editor?: EditorThemeOverrides }` —
  there is deliberately no separate "terminal colour scheme" or "editor colour
  scheme" picker:
  - `ui` — the full chrome token set (background, card, popover, primary,
    secondary, muted, accent, tertiary, border/input/ring, sidebar…), the same
    vocabulary as WPHerd's `src/index.css` variables.
  - `terminal` — the complete xterm palette: background, foreground, cursor,
    cursorAccent, selectionBackground + all 8 ANSI + 8 bright ANSI. Optional;
    falls back to `getDefaultTerminalColors(theme.type)`.
  - `editor` — CodeMirror/diff colours (gutter, active line, selection, search,
    panel chrome, addition/deletion/modified) plus an `EditorSyntaxColors` set
    (comment, keyword, string, number, functionCall, variableName, typeName,
    className, constant…). Optional; otherwise **derived from the UI + terminal
    tokens** — exactly what WPHerd's `src/lib/editorTheme.js` already does by
    mapping the ANSI set onto CodeMirror highlight tags.

  Built-ins ship as Ember (dark, default), Light, and Monokai. Custom themes are
  imported from a JSON file (`parseThemeConfigFile`, 256 KB cap) and appear in a
  "Custom" group in the same dropdown.

  For WPHerd this is mostly plumbing: `src/lib/theme.js` already holds
  `terminalThemes` (with the ANSI/bright set) and `uiColors`, and everything
  themable already resolves through a CSS variable. The work is promoting those
  two objects into a named-theme record, persisting a selected id, and letting the
  System option pick a light/dark pair instead of being implicit.

- **Typography — terminal and code editor fonts.** Superset stores two independent
  blocks (`packages/local-db` settings table):
  - terminal — `terminalFontFamily`, `terminalFontSize`, `terminalLineHeight`,
    `terminalLetterSpacing`, `terminalFontWeight`, `terminalLigatures`,
    plus terminal-only `terminalMinimumContrast` (the one colour knob that is *not*
    part of the theme — it enforces legibility against whatever the theme picked),
    `terminalCursorStyle` (block / bar / underline) and `terminalCursorBlink`.
  - editor — `editorFontFamily`, `editorFontSize`, `editorLineHeight`,
    `editorLetterSpacing`, `editorFontWeight`, `editorLigatures`.

  Font family is a combobox backed by `useSystemFonts`, which probes a curated
  list — Nerd Fonts, then well-known monos (JetBrains Mono, Fira Code, Menlo,
  Iosevka, Geist Mono, …) — categorises them into Nerd / Mono / Other, adds
  runtime-registered faces like SF Mono on macOS, and accepts a free-typed family
  with a "font not found" banner if it doesn't resolve. Both blocks render live
  preview surfaces.

  WPHerd hardcodes a single `MONO_STACK` for both the xterm terminal and the
  CodeMirror editor. Users of a local-dev tool live in that terminal, and Nerd Font
  support matters the moment someone runs a themed shell prompt inside an agent
  session — this is worth taking close to verbatim, including the two-block split.
- **Terminal presets.** Superset's preset = name + description + cwd + commands.
  WPHerd's version writes itself: per-site presets like `wp db cli`,
  `npm run dev` in the active theme dir, `wp cron event run --due-now` — launchable
  from the site page. Plus a sessions list (`agents.cjs` already tracks sessions)
  with kill buttons.
- **Agents section.** `electron/services/agents.cjs` hardcodes claude / codex /
  gemini / opencode. Expose enable-disable, per-agent launch command, and
  user-defined agents — exactly `AGENTS_ENABLED` / `AGENTS_COMMANDS`.
- **Keyboard shortcuts** with rebinding and conflict detection.
- **macOS Permissions page.** Superset's status + deep-link pattern. WPHerd's
  sudoers row is the seed; add Full Disk Access (sites in `~/Documents`/iCloud) and
  Local Network (`.test` resolution). Keep it `macOnly`-gated like Superset does.
- **Sharing / Security.** `cloudflared.cjs` already exists — global defaults for
  tunnel sharing (auto-expire, basic auth, which sites may be exposed) belong in a
  Security section, mirroring `SECURITY_EXPOSE_HOST_SERVICE_VIA_RELAY`.
- **Experimental flags** with the same "early access, may break" framing.

### Tier 3 — adopt only if the feature arrives

- **Models.** Only meaningful once WPHerd itself calls a model (AI site naming,
  log explanation, error triage). If that happens, copy Superset's shape: OAuth
  *or* API key, a status badge, and a collapsed Advanced block for base URL /
  auth token / extra env, saved on blur.
- **Account / Organization / Teams / Billing / Hosts / Integrations.** Superset is
  a multi-user cloud product; WPHerd is single-user and local. Skip.
- **Git & Worktrees.** Only if WPHerd grows a git workflow beyond `git.cjs`.

### Explicitly not worth copying

- Per-setting `v1` / `v2` variant gating — that exists to run two UIs at once.
- Markdown render style, file open mode (split pane / new tab) — no WPHerd surface
  needs them yet.
- The in-app browser toggle: WPHerd opens sites in a real browser on purpose.

---

## 4. Suggested build order

1. Settings shell: routes, sidebar, shared `SettingsRow`, auto-save store writes.
2. Move the five existing cards into their sections unchanged.
3. Tier 1 rows (fastest user-visible win — mail catch and confirm-on-quit alone
   remove two real papercuts).
4. Setting registry + search.
5. Appearance + typography.
6. Terminal presets, agents, keyboard, permissions.
