# Upgrade Electron 28 → 43

> **Status:** **implemented** (Steps 1–4) in the working tree on `develop`, not
> committed. The automated gate (section A of the test doc) and the headless half
> of packaging (B12 build, B13) pass; sections B–D still need a manual run.
> If this should live on its own branch, `chore/electron-43-upgrade` off `develop`
> was the suggestion.
>
> Resolves finding 0.2 of
> [issue #24](https://github.com/aminurislamarnob/WPXen/issues/24).
> Explicitly **out of scope:** the `node-pty` fd-leak pin (finding 0.1) — separate change.

## Context

WPXen ships `electron ^28.2.10` (installed: 28.3.3). Electron supports only the
latest three stable majors — at the time of writing **41, 42, 43** — so 28 has been
out of the security-support window since roughly mid-2024.

The severity driver: `electron/main.cjs:74` sets `webviewTag: true`, and
`src/lib/browser/webviewCache.js` renders **arbitrary user-entered http/https
pages** in the Agents screen's in-app browser. Verified against
`releases.electronjs.org/releases.json`:

| Electron        | Chromium   | Node  |
| --------------- | ---------- | ----- |
| 28.3.3 (ours)   | 120.0.6099 | 18.18 |
| 43.4.1 (target) | 150.0.7871 | 24.18 |

Thirty Chromium majors of security fixes are missing from the shipped product.

Target chosen deliberately over 41 (oldest supported): 41 falls out of support in
~4 months and avoids none of the real work, since the E42 postinstall change (see
Step 2) has to be absorbed eventually anyway.

### Survey results (all verified first-hand — do not re-derive)

The runtime API surface is **nearly clean**. The app already uses the modern form
of everything that changed 29→43: `app.whenReady()` not `on('ready')`,
`setWindowOpenHandler` not `new-window`, `contextIsolation: true`, no
`@electron/remote`, no `BrowserView`, no `session.setPreloads`, no `File.path`,
no `crashed`/`renderer-process-crashed` events, async object-shape `dialog`
returns. Checked against Electron 43.4.1's own `electron.d.ts`:
`titleBarStyle: 'hiddenInset'`, `trafficLightPosition`, `app.dock` (still
`Dock | undefined`, so `app.dock?.hide()` is correct), and main-process
`clipboard.writeText` are all unchanged. The E43 renderer-clipboard removal is
irrelevant — the renderer already uses `navigator.clipboard`.

Only two things bite:

1. **Electron 42 deleted the `postinstall` binary download**, and with it
   `ELECTRON_SKIP_BINARY_DOWNLOAD` (confirmed by unpacking the electron@43.4.1
   tarball: the env var appears nowhere in `index.js`/`install.js`; `index.js`
   runs `module.exports = getElectronPath()` at module scope and on a missing
   `path.txt` **spawns a ~100MB download** instead of throwing). That env var is
   what `.github/workflows/ci.yml` sets, and it is the entire enforcement behind
   the rule in `CLAUDE.md` — _never `require('electron')` at module scope in
   anything a test imports_. Under 43 the rule would silently stop being
   enforced. Replacing that guard is the core of this change (Step 2).

2. **`webContents.canGoBack/goBack/canGoForward/goForward` are deprecated**
   (moved to `webContents.navigationHistory`). Deprecated-not-removed in 43's
   typings, so a should-fix riding along (Step 3).

**`node-pty` needs no rebuild.** Verified with `nm` on
`node_modules/node-pty/prebuilds/darwin-arm64/pty.node`: 0 undefined V8 symbols,
38 N-API symbols, exports `_napi_register_module_v1` — pure Node-API, ABI-stable
across Electron majors. This removes the usual riskiest part of an Electron bump.

## Step 1 — Bump the dependencies

`package.json`:

| Package             | From       | To         | Why                                                                                                                              |
| ------------------- | ---------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `electron`          | `^28.2.10` | `^43.4.1`  | the upgrade                                                                                                                      |
| `electron-builder`  | `^24.13.3` | `^26.15.3` | v24 is end-of-line, predates recent macOS signing changes, no knowledge of Electron 4x. (`^26.15.3` resolves to 26.15.7 — fine.) |
| `@electron/rebuild` | `^3.7.2`   | `^4.2.0`   | keep in step with builder (installed but never invoked — packaging relies on electron-builder's default `npmRebuild`)            |

Also raise `engines.node` from `>=18.0.0` to `>=20.0.0` (Electron 43 bundles
Node 24; the current floor is below both that and CI's Node).

Then `rm -rf node_modules package-lock.json && npm install` — `npm ci` against
the old lockfile will not resolve the new tree.

## Step 2 — Replace the CI guard (the core of this change)

`.github/workflows/ci.yml`:

- **Delete** the `env: ELECTRON_SKIP_BINARY_DOWNLOAD: '1'` block and its comment.
  It is inert on Electron 43. Not a loosening — with no `postinstall` script,
  `npm ci` no longer downloads the binary _at all_, so CI gets faster.
- Bump `node-version` from `'20'` to `'22'`.

New test **`test/no-module-scope-electron.test.js`**, modelled on Superset's
`no-main-process-blocking.test.ts` ratchet (Tier 2.1 in issue #24):

- Walk `electron/**/*.cjs`. Count lines that (a) match
  `/require\(['"]electron['"]\)/`, (b) **begin at column 0** (non-whitespace
  first character) — that is what distinguishes a module-scope require from a
  lazy one — and (c) are **not comments** (skip lines whose trimmed content
  starts with `//` or `*`).
  - ⚠️ The comment exclusion is load-bearing, found during verification:
    `electron/services/browser.cjs:18` is a column-0 comment line mentioning
    `require('electron')` inside a block comment, and without (c) the ratchet
    fails on day one against a file doing everything right.
  - Verified against the current tree, the pattern with (c) catches exactly five
    lines: `main.cjs:3`, `preload.cjs:3`, `tray.cjs:3`, `store.cjs:5`, and
    `ipc.cjs:11` (the closing `} = require('electron');` of a multi-line
    destructure — `}` at column 0, so it is caught). It correctly ignores the
    indented lazy requires in `browser.cjs`, `safeUrl.cjs`, `siteops.cjs`,
    `blueprints.cjs`, `procman.cjs`.
- Assert against an explicit `allowedCounts` map — the five files above at 1
  each, every other file 0. Header comment states the ratchet's two rules:
  a file exceeding its count fails with advice to resolve the require lazily
  inside the function that uses it; a file dropping below its count must have
  its entry **lowered or deleted**, so the ratchet only ever tightens.
- Safety check already done: no `electron/services/*.cjs` requires `store.cjs`,
  `ipc.cjs` or `tray.cjs`, so none of the 17 electron-importing test files can
  currently reach an allowlisted file. The ratchet keeps it that way.

Update `CLAUDE.md` (the "⚠️ CI installs with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`"
paragraph, currently lines 29–38): the env var no longer exists, and its
reproduction recipe ("move `node_modules/electron/path.txt` aside") now produces
a silent download rather than a failure. Rewrite to state the rule, point at the
ratchet test as the enforcement, and record why the env var is gone.

## Step 3 — Migrate the deprecated navigation API

`electron/services/browser.cjs:200-201`, in the context-menu builder:

```js
{ label: 'Back',    enabled: wc.navigationHistory.canGoBack(),    click: () => wc.navigationHistory.goBack() },
{ label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
```

`test/browser-manager.test.js` hand-mocks these on its fake guest — defaults at
lines 33-34, override at line 378 — so the mock shape moves to a nested
`navigationHistory` object alongside the source change.

**Leave `src/lib/browser/webviewCache.js:229,238,251-252` alone.** Those are
`<webview>` **element** methods, and `WebviewTag.canGoBack()` carries no
deprecation marker in Electron 43's typings.

## Step 4 — Declare the macOS floor

Add to `build.mac` in `package.json`:

```json
"minimumSystemVersion": "12.0"
```

Verified: the v43.4.1 README says "macOS (Monterey and up)". (An Electron-43
breaking-change note about removed login-item options mentions macOS 12; the
tagged README is authoritative — the floor is 12, not 13.) Electron 38 dropped
macOS 11, 33 dropped 10.15. Without this key the DMG installs on machines the
runtime cannot start on.

## Step 5 — Verify the packaging path

Least-covered part of the repo: **no CI job packages the app** (the pipeline
stops at `vite build`), no notarization config, and `hardenedRuntime: true` with
no entitlements plist — electron-builder 24's bundled defaults do that job today
and v26's may differ. `npm run pack` is the check. Two pre-existing loose ends:

- `build.extraResources` copies from `assets/bin`, **which does not exist**
  (`assets/` holds only README.md, icon.icns, tray.png, tray@2x.png). Works
  today only because builder 24 tolerates it. If v26 errors, drop the stanza —
  nothing else references it.
- node-pty's `spawn-helper` is a plain Mach-O executable, not a `.node`, so it
  rides on electron-builder's default asar-unpack heuristic. If the terminal
  fails to spawn in a packaged build, add
  `"asarUnpack": ["**/node_modules/node-pty/**"]`.

## Files touched

- `package.json` — deps, `engines.node`, `build.mac.minimumSystemVersion`
- `package-lock.json` — regenerated
- `.github/workflows/ci.yml` — drop the env block, Node 20 → 22
- `test/no-module-scope-electron.test.js` — new
- `electron/services/browser.cjs` — `navigationHistory` migration
- `test/browser-manager.test.js` — mock shape follows
- `CLAUDE.md` — rewrite the CI constraint note

Deliberately unchanged: `main.cjs` (every constructor option and lifecycle hook
it uses is valid on 43), `preload.cjs`, `tray.cjs`, `ipc.cjs`, all of `src/`.

## Verification

> Full test-case suite with IDs, steps and expected results:
> **`plans/electron-43-upgrade-tests.md`**. The list below is the short form;
> the test doc is what to actually execute and report against.

1. `npm run lint && npm run format:check && npm test && npm run build:renderer`
   — the four CI steps in order; each gates the next (see CLAUDE.md).
2. **Ratchet proves itself:** temporarily hoist `browser.cjs`'s lazy require to
   module scope, confirm `npm test` fails with the advice message, revert.
   Without this the test could be vacuously passing.
3. **CI does not download Electron:** the workflow's `npm ci` emits no
   "Downloading Electron binary..." line and `node_modules/electron/path.txt`
   is absent afterwards.
4. `npm run dev` — app launches, tray icon appears, correct opaque window
   backdrop; toggle macOS appearance and confirm the backdrop follows
   (`nativeTheme` `updated` → `setBackgroundColor`, `main.cjs:133-135`).
5. **Agents terminal** — open a site's agent session, confirm the pty spawns
   (proves node-pty's N-API prebuild loads against Electron 43's ABI — the
   single biggest assumption in this plan), type, resize, hide the window to
   the tray and reopen to confirm reattach.
6. **In-app browser** — load an external https page; Back/Forward in the
   right-click menu (the Step 3 change), Cmd+R interception, "Open Page in
   Default Browser", and a `file://` URL still refused by the `will-navigate`
   guard in `browser.cjs`.
7. **Quit path** — `main.cjs`'s `before-quit` does async teardown behind
   `preventDefault()` with a 30s race ending in `app.exit(0)`. Quit with
   services running; confirm they stop and the app actually exits.
8. `npm run pack`, launch the unpacked app from `release/`, repeat 5 and 6 —
   packaged builds are where asar/native-binary problems surface, and CI will
   not catch them.

## Follow-ups, deliberately not in scope

- **No permission handlers exist.** With `webviewTag: true` on arbitrary web
  content there is no `session.setPermissionRequestHandler` /
  `setPermissionCheckHandler` anywhere — camera, mic, geolocation and
  notifications in guests are ungated, and Electron 37+ tightened permission
  defaults. Worth its own issue.
- `main.cjs:78` attaches `hardenWebviews` only to the main window's
  `webContents` rather than via `app.on('web-contents-created')` — any future
  window would be unguarded.
- `tray.cjs:40,54` call `shell.openExternal` directly, bypassing
  `openExternalSafely` — contradicts the "only path out of the app" rule.

## Session notes for whoever implements this

- A PreToolUse hook (`no_touch.py`, weLabs plugin) blocks writes outside this
  repo and Bash commands mixing mutation with outside paths — hence this plan
  lives in `plans/`, not `~/.claude/plans/`.
- Useful artifacts already in this session's scratchpad
  (`/private/tmp/claude-501/-Users-aiarnob-WPHerd-WPXen/ac148e8a-b0d1-4767-b343-7cffbc8a7a5f/scratchpad/`):
  the unpacked electron@43.4.1 npm tarball under `etest/package/` (its
  `electron.d.ts`, `index.js`, `install.js` back the claims above) and
  `releases.json` from releases.electronjs.org. Scratchpads are
  session-temporary — re-fetch if gone.
- The user declined branch creation once already; confirm before creating the
  branch, and commit/push only when asked.
