# Electron 28 → 43 — Test Cases

Companion to `plans/electron-43-upgrade.md`. Run **after** implementation, in the
order given: automated gate first, then P0 (upgrade-critical paths), then the
P1/P2 regression of every feature — an Electron major bump moves Chromium
120→150 and Node 18→24 underneath the whole app, so nothing is exempt.

Conventions:

- Each case: **ID · Precondition · Steps · Expected**. Mark ✅/❌/⏭ (skipped, with
  reason) as you go; report failures with output, per repo policy.
- "Packaged" = the app from `npm run pack` output in `release/`, not `npm run dev`.
  Any case marked **[dev+pack]** must pass in both — packaged is where
  asar/native-binary problems surface, and CI never packages.
- Cases that talk to Homebrew services (nginx, MySQL, dnsmasq…) have real side
  effects on the machine. That is the point — this app orchestrates them — but
  don't run P1 site-lifecycle cases on a machine whose local sites you can't
  afford to disturb.

---

## A. Automated gate (run before any manual case)

### A1 — Four CI steps, in order

```
npm run lint && npm run format:check && npm test && npm run build:renderer
```

**Expected:** all four pass. Each gates the next (CLAUDE.md), so on a failure
check _which_ step stopped — don't assume the first error is the only one.

### A2 — Ratchet test exists and passes

**Steps:** `npx vitest run test/no-module-scope-electron.test.js`
**Expected:** passes, with exactly five allowed module-scope requires:
`main.cjs`, `preload.cjs`, `tray.cjs`, `store.cjs`, `ipc.cjs` (1 each).

### A3 — Ratchet proves itself (not vacuously passing)

**Steps:** In `electron/services/browser.cjs`, temporarily add
`const { webContents } = require('electron');` at column 0 near the top. Run A2
again. **Revert.**
**Expected:** test **fails**, naming `browser.cjs`, and the failure message
advises resolving the require lazily inside the function that uses it.

### A4 — Ratchet ignores comments

**Steps:** Confirm `electron/services/browser.cjs:18` (the column-0 comment line
mentioning `require('electron')`) is present and A2 still passes.
**Expected:** pass — the comment is not counted. This was the false-positive
found during plan verification; if someone "simplified" the regex, this catches it.

### A5 — No stale env var references

**Steps:** `grep -rn ELECTRON_SKIP_BINARY_DOWNLOAD .github/ CLAUDE.md package.json`
**Expected:** no hits in `.github/`. CLAUDE.md may mention it only historically
(explaining why it's gone). Comments in `electron/services/*.cjs` that explain
the lazy-require seam may keep their wording or be updated — either way the
_rule_ they describe still holds via the ratchet.

### A6 — CI dry-run: install does not download Electron

**Steps:** `rm -rf node_modules && npm ci && ls node_modules/electron/`
**Expected:** install completes with **no** "Downloading Electron binary..."
line; `node_modules/electron/path.txt` and `dist/` are absent until first run.
(Then `npm install` or first `npm run dev` fetches the binary — expected.)

### A7 — Dependency resolution sanity

**Steps:** `node -e "console.log(require('electron/package.json').version, require('electron-builder/package.json').version)"`
**Expected:** electron `43.x` (≥ 43.4.1), electron-builder `26.x`.

### A8 — Existing suite untouched by the mock migration

**Steps:** `npx vitest run test/browser-manager.test.js`
**Expected:** passes, with the fake guest now shaped
`{ navigationHistory: { canGoBack, canGoForward, goBack, goForward } }` and the
context-menu assertions (Back enabled/disabled) still meaningful — i.e. the
test still asserts the _enabled_ flags, not merely that menu items exist.

---

## B. P0 — Upgrade-critical paths **[dev+pack]**

These exercise the four things the upgrade actually risks: native-module ABI,
the `<webview>` surface, the async quit dance, and packaging.

### B1 — Launch & window chrome

**Steps:** `npm run dev`. Watch the first paint.
**Expected:** app starts with no dock icon (menu-bar app), tray icon appears,
window opens centered ≤1200×800, `hiddenInset` title bar with traffic lights at
(16,18), backdrop is `#151110` (dark) or `#ffffff` (light) with **no flash of
the wrong color** — the `backgroundColor` option and `windowBackground()` in
`main.cjs` still line up on Electron 43.

### B2 — Theme follows macOS

**Steps:** With the window open, flip System Settings → Appearance twice.
**Expected:** UI tokens flip both ways with no white/black flash (the
`nativeTheme` `updated` → `setBackgroundColor` path, `main.cjs:133-135`);
terminal and editor palettes flip too (`onThemeChange`).

### B3 — Agents pty spawns (node-pty ABI — the single biggest assumption)

**Precondition:** at least one site exists; any provider CLI (or the plain
`Terminal` provider) available.
**Steps:** Agents → pick a site → open a terminal session. Type `echo ok`,
resize the pane, run something that scrolls (`ls -R` in webroot).
**Expected:** pty spawns rooted at the site's webroot; keystrokes echo; resize
reflows with no error. Failure mode to watch for: an N-API version error or
`Module did not self-register` from `pty.node` — that would falsify the
"no rebuild needed" claim and mean adding an `@electron/rebuild` step.

### B4 — Terminal reattach from tray

**Steps:** With B3's session showing output, close the window (hides to tray),
wait 10s, reopen from the tray, return to the session.
**Expected:** session still live (pty survives in main process, ADR 0001);
scrollback replayed from the ring buffer. Known pre-existing blemish: replay of
a TUI can arrive mid-escape-sequence (issue #24 finding 0.4) — garbled TUI
redraw is **not** a regression of this upgrade; a dead/blank session is.

### B5 — In-app browser: guest creation and hardening

**Steps:** Agents → browser pane → load `https://example.com`, then a local
site's `.test` URL.
**Expected:** pages render (Chromium 150 guest); DevTools via context menu →
Inspect Element opens detached. The `will-attach-webview` clamp in `main.cjs`
still applies — no preload, sandboxed guest.

### B6 — Browser navigation & the migrated context menu

**Steps:** In the guest: navigate A → B, right-click.
**Expected:** context menu shows Back **enabled** / Forward disabled; click
Back → returns to A, Forward now enabled. This is the Step 3
`navigationHistory` change in `browser.cjs:200-201` running against a real
guest, not the test mock.

### B7 — Browser scheme guard still bites

**Steps:** In the browser address bar try `file:///etc/hosts`, then
`javascript:alert(1)` (type, don't let anything execute — expected outcome is
refusal, so no dialog should ever appear).
**Expected:** both refused (sanitize + `will-navigate`/`will-redirect` guards);
tab stays on its previous page. Also: a target=_blank link opens via
`setWindowOpenHandler` → `browser-new-window` as a new in-app tab, never a new
Electron window.

### B8 — Tab hide/show keeps guest state

**Steps:** In a guest, scroll halfway down a long page, switch to another
app section (unmounts the pane), switch back.
**Expected:** same page, same scroll position, no reload — the re-parenting
cache (`webviewCache.js`) still works; and because re-parenting mints a new
`webContentsId`, Back/Forward and the context menu still work **after** the
round-trip (re-registration on `dom-ready`).

### B9 — Cmd-key interception inside the guest

**Steps:** Focus the guest, press Cmd+R, then Cmd+W.
**Expected:** Cmd+R reloads the _guest_ (not WPXen); Cmd+W does **not** hide
the app window (the `before-input-event` interception in `browser.cjs`).

### B10 — Quit path with services running

**Precondition:** at least one service running (nginx or MySQL as app children).
**Steps:** Quit via tray menu. If `app.confirmOnQuit` is on, both answer paths.
**Expected:** confirm dialog (`showMessageBoxSync`) appears and blocks; on
confirm, services stop (verify `pgrep nginx`/`pgrep mysqld` show the supervised
children gone), app exits fully — process list clean, no orphan reappearing in
"App Background Activity". The async `before-quit` preventDefault-then-`app.exit(0)`
race in `main.cjs` is the highest-risk lifecycle code on a new major.

### B11 — Single instance & activate

**Steps:** With the app running, launch it again (`npm run electron` or open
the packaged .app twice). Then hide to tray and click the dock-less app via
Spotlight/tray double-click.
**Expected:** second launch does not start a second app — the first window is
shown/focused (`second-instance`); `activate`/tray reopen shows the window and
the dock icon while visible.

### B12 — Packaged build

**Steps:** `npm run pack`; launch `release/mac-arm64/WPXen.app` (and the x64
slice under Rosetta if available). Re-run B1, B3, B5.
**Expected:** builds without error under electron-builder 26 — if it rejects
the missing `assets/bin` extraResources dir, that's the known pre-existing
loose end (drop the stanza). App launches; **terminal spawns** (node-pty's
`pty.node` _and_ `spawn-helper` unpacked from asar — if spawn fails here but
worked in dev, add `asarUnpack` for node-pty); browser guest renders.

### B13 — DMG install floor

**Steps:** Inspect `release/*.dmg` → app bundle `Contents/Info.plist` →
`LSMinimumSystemVersion`.
**Expected:** `12.0`.

---

## C. P1 — Core feature regression

### C1 — Onboarding / setup screen

**Steps:** (Fresh-profile run if practical: temporarily move
`~/Library/Application Support/WPXen` aside — restore after.) Launch.
**Expected:** setup detects Homebrew prefix and installed/missing services
correctly on Node 24's process model; brew-command copy button writes to
clipboard (`navigator.clipboard` in renderer — unaffected by the E43 clipboard
change, verify anyway).

### C2 — Rebrand migration still works

**Steps:** With the fresh profile from C1, seed
`~/Library/Application Support/WPDevPilot/wpdevpilot-data.json` with a dummy
site entry. Launch.
**Expected:** data copied (not moved) into `WPXen/wpxen-data.json`; the dummy
site listed. (Automated coverage exists in `test/rebrand.test.js`; this checks
the real `app.getPath` wiring.)

### C3 — Create a site (the long pipeline)

**Steps:** Sites → New site → `upgradetest.test`, latest PHP.
**Expected:** progress streams step-by-step over `site-create-progress`
(download WP → DB → wp-config → install → vhost → nginx reload); site loads in
the in-app browser and in Safari; magic login works. This exercises
`execSync`/spawn flows on Node 24, the store write, nginx vhost generation and
dnsmasq resolution end-to-end.

### C4 — Service start/stop/restart & status poller

**Steps:** Toggle nginx, PHP-FPM, MySQL, Mailpit off and on from the UI and the
tray. Kill one child manually (`kill <pid>`).
**Expected:** statuses update on the poller interval (`service-status-update`);
killed child is restarted by procman with backoff; pid files reconciled.

### C5 — PHP version switch

**Steps:** Switch a site (or global) PHP version between two installed versions.
**Expected:** FPM restarts on the new version, site serves with it
(`phpinfo()`/Site Doctor equivalent), `zz-wpxen.ini` conf.d override intact.

### C6 — Export / Import / Clone / Blueprint

**Steps:** Export `upgradetest.test` (both archive formats if offered), import
it back under a new domain, clone it, snapshot a blueprint and create from it.
**Expected:** every entry point streams `{step, message}` progress; long
WP-CLI calls complete within the `wpAsync` budget; imported/cloned sites load.
Blueprint zip written under `userData/blueprints/`.

### C7 — Delete a site

**Steps:** Delete the clone from C6.
**Expected:** files, DB, vhost, and hosts entries removed; nginx reloaded; no
dangling `.test` domain. (Confirm-before-destroy dialog appears.)

### C8 — Mailpit catch & Mail page

**Steps:** Toggle mail catching on; from a site run
`wp eval 'wp_mail("a@b.test","hi","body");'`; open the Mail page. Toggle off.
**Expected:** message appears (REST wrapper works); toggle off clears **all**
generations of sendmail overrides so `mail()` stops routing to Mailpit.

### C9 — phpMyAdmin

**Steps:** Open phpmyadmin.test from a site's page.
**Expected:** serves and auto-logs-in with stored credentials.

### C10 — HTTPS via mkcert & tunnels

**Steps:** Enable HTTPS on a site; open it. If `cloudflared` installed, start a
tunnel, open the public URL, copy it (clipboard), stop it.
**Expected:** locally-trusted cert, no browser warning (test in the in-app
browser too — the guest must trust the mkcert CA the same as before);
tunnel URL reachable; stop tears the process down.

### C11 — File explorer & code editor

**Steps:** In Agents, browse the webroot; create, rename, trash a file; open
`wp-config.php` in the editor, edit, save; open in external editor.
**Expected:** all fs operations work (synchronous fs on main, Node 24); trash
goes to macOS Trash (`shell.trashItem`); CodeMirror renders, saves round-trip;
"open in editor" launches the configured app via its CLI shim.

### C12 — Git changes pane

**Precondition:** a site webroot with a git repo and a dirty file.
**Expected:** Changes pane lists the modification with a correct diff.

### C13 — Settings: optimistic writes & side effects

**Steps:** Flip several settings: theme-independent one (confirm-on-quit),
`app.startAtLogin`, close-action, "Open links in". Check System Settings →
Login Items after the startAtLogin flip. Force a rejection (if feasible) to see
rollback.
**Expected:** UI updates instantly, persists; `setLoginItemSettings` actually
registers/deregisters the login item on 43 (E43 removed only the
`openAsHidden`-family options, which the app never used); a settings change
made from the tray/Mail page lands live in an open Settings window
(`settings-updated`).

### C14 — Settings search

**Steps:** Search for "login", "browser", "PHP".
**Expected:** registry-driven results navigate to the right section.

### C15 — Clear browsing data

**Steps:** Log into some site in the in-app browser; Settings → clear browsing
data; reload the tab.
**Expected:** session gone — `session.fromPartition('persist:wpxen-browser')`
still names the same partition the `<webview>` uses (the duplicated-constant
invariant; also asserted in tests).

### C16 — External links policy

**Steps:** With "Open links in: system", click an outbound link from the app
chrome (not the guest); repeat with "app".
**Expected:** system → default browser via `openExternalSafely` (http/https
only); app → in-app tab. Tray's "open site" entries also open correctly
(known pre-existing: tray bypasses the safe wrapper — unchanged behavior, not
a regression).

### C17 — dnsmasq resolver setup

**Steps:** Only if safe on this machine: Settings → the one-click resolver
setup.
**Expected:** macOS admin dialog appears (osascript path unchanged);
`/etc/resolver/test` written; `dig upgradetest.test @127.0.0.1` resolves.

### C18 — Logs page

**Steps:** Open service logs, generate traffic, watch tail.
**Expected:** log panes stream on `bg-background`, follow theme flips.

---

## D. P2 — Renderer details worth a glance (Chromium 120 → 150)

- **D1 Terminal rendering:** WebGL addon still active (no silent canvas
  fallback — check for a `webgl` context on the term canvas); ligatures/wide
  chars OK via unicode11 addon; links clickable (web-links addon).
- **D2 Clipboard in terminal:** copy on selection / Cmd+V paste path
  (`keys.js` literal-^V forwarding) unchanged.
- **D3 Editor:** CodeMirror themes match `editorTheme.js` mapping in both
  appearances; merge view (diff) renders.
- **D4 Layout:** resizable panels drag correctly; no scrollbar styling
  regressions (Chromium changed scrollbar/`::-webkit-*` behavior across these
  30 majors); `max-w-[735px]` pages center.
- **D5 Icons/fonts:** lucide icons crisp on Retina; `MONO_STACK` font fallback
  unchanged.
- **D6 Devtools:** main-window devtools opens (uncomment in dev or Cmd+Opt+I)
  with no preload/sandbox warnings tied to `sandbox: false` + preload.
- **D7 Console hygiene:** with devtools open, click through every top-level
  page; **zero** new deprecation warnings from Electron in the main-process
  terminal output and no renderer errors. Electron logs deprecations loudly —
  a `(electron) 'canGoBack' is deprecated` line means a migration was missed.

---

## E. Reporting

Summarize as a table: `ID | ✅/❌/⏭ | note`. For any ❌: exact output, whether it
reproduces in dev, pack, or both, and whether it predates the upgrade (check
against `develop` at Electron 28 before calling it a regression). B-section
failures block the upgrade; C/D failures are judged individually — pre-existing
issues get filed, not fixed in this branch.

---

## F. Run 1 — results (2026-08-20, `chore/electron-43-upgrade` @ `cfde8d4`)

Machine: macOS 25.5.0, arm64. Everything below was executed headlessly — the
automated gate, plus three probes that drive the risky paths without a GUI.
**Sections B (except B3/B6-API/B12/B13), C and D are not yet run**; they need
eyes on pixels, real user gestures, or live Homebrew services.

| ID                     |       | Note                                                                                                                                                                                                                                                                                           |
| ---------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1                     | ✅    | Four steps in order, 408 tests. `format:check` first flagged the two untracked plan docs — reformatted, not a code issue                                                                                                                                                                       |
| A2                     | ✅    | 39 tests; exactly the five allowlisted files at 1 each                                                                                                                                                                                                                                         |
| A3                     | ✅    | Hoisting a require into `browser.cjs` fails the test **by name**, quotes the offending line, and gives the lazy-resolve advice. Reverted                                                                                                                                                       |
| A4                     | ✅    | `browser.cjs:18` is still a column-0 comment quoting the require; suite green                                                                                                                                                                                                                  |
| A5                     | ✅    | No hits in `.github/`; one historical mention in CLAUDE.md explaining why the env var is gone                                                                                                                                                                                                  |
| A6                     | ✅    | `npm ci` in 4s, **no** download line, no `path.txt`/`dist/`                                                                                                                                                                                                                                    |
| A7                     | ✅    | electron 43.4.1, electron-builder 26.15.3, @electron/rebuild 4.2.0                                                                                                                                                                                                                             |
| A8                     | ✅    | 29 tests; Back-enabled/Forward-disabled assertions still assert `enabled` flags                                                                                                                                                                                                                |
| B3                     | ✅    | **The plan's single biggest assumption.** Real pty spawned inside an Electron 43 main process: `electron 43.4.1 / node 24.18.1 / modules 148`, pid allocated, `echo` round-tripped, `resize(120,40)` clean. No N-API version error, no `Module did not self-register`                          |
| B6                     | ⚠️ ✅ | **API half only.** Hidden window driven A→B→back→forward against the real Electron 43 API, calling exactly what `browser.cjs:200-207` now calls: `canGoBack` false→true, `goBack()` lands on A, `canGoForward` true, `goForward()` lands on B. The right-click menu itself still needs a human |
| B12                    | ⚠️ ✅ | **Build + terminal halves.** `npm run pack` clean under builder 26; node-pty rebuilt for 43.4.1; packaged node-pty loaded _through `app.asar`_ resolves `helperPath` into `app.asar.unpacked` and spawns. **No `asarUnpack` stanza needed.** Launching the packaged app still needs a human    |
| B13                    | ✅    | `LSMinimumSystemVersion` = `12.0`                                                                                                                                                                                                                                                              |
| D7                     | ⚠️ ✅ | **Main-process half.** Dev app idled for minutes with zero main-process output — no `(electron) '...' is deprecated` lines, no errors. (The one "deprecated" string in the log is Vite's own CJS-API notice, pre-existing.) Renderer console still needs devtools                              |
| B1, B2, B4, B5, B7–B11 | ⏭     | Need GUI/gestures                                                                                                                                                                                                                                                                              |
| C1–C18                 | ⏭     | Need live Homebrew services and real site lifecycle                                                                                                                                                                                                                                            |
| D1–D6                  | ⏭     | Need devtools and visual inspection                                                                                                                                                                                                                                                            |

### Loose ends resolved

Both of the plan's Step 5 flagged risks turned out benign under builder 26:

- **`assets/bin`** — builder 26 _tolerates_ the non-existent `extraResources`
  source (two `file source doesn't exist` warnings, no error). Stanza left in
  place per the plan's "drop it only if v26 errors"; still worth deleting
  separately, since nothing references it.
- **`asarUnpack` for node-pty** — not needed. `pty.node` _and_ `spawn-helper`
  both land in `app.asar.unpacked` via builder's default heuristic, and the
  spawn works from there.

### New observations

- **`@electron/rebuild` is now redundant.** Builder 26 bundles it and says so:
  `@electron/rebuild already used by electron-builder, please consider to remove
excess dependency from devDependencies`. The bump to `^4.2.0` is consistent,
  but the dependency is a deletion candidate.
- **CI actions are on deprecated Node 20.** `actions/checkout@v4` and
  `actions/setup-node@v4` are being force-run on Node 24 by the runner. A
  warning, not a failure; `@v5` for both is a separate one-liner.
- **Packaged app is unsigned** (`0 valid identities found`), so Gatekeeper
  blocks first open — right-click → Open, or clear the quarantine xattr. This
  predates the upgrade.

### Methodology note

A `posix_spawnp failed` from the packaged node-pty during this run was a **probe
artifact, not an app defect**: requiring node-pty from the unpacked directory
directly makes its naive `.replace('app.asar', 'app.asar.unpacked')` double into
`app.asar.unpacked.unpacked`. Loading through the asar, as the app does, is
correct. Anyone re-running B12 headlessly should load via the `app.asar` path.

---

## G. Run 2 — after merging `develop` (2026-08-21, `chore/electron-43-upgrade` @ `ddd0419`)

Run 1 tested the upgrade against a branch that had since fallen 15 commits
behind `develop` — the agents work (one-click installs, three new providers,
the wrapper-shim detection fix, the PHP-probe memoisation) had never been built
or tested on Electron 43. `develop` was merged in for this run; it merged
without conflicts, the two changesets not overlapping.

| ID  |     | Note                                                                                                                                                                                                             |
| --- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | ✅  | Full gate on the merged tree, locally and on CI (run 32405881541, 42s). **459 tests** = `develop`'s 420 + this branch's 39-test ratchet, so nothing was dropped in the merge                                     |
| B12 | ✅  | **Now complete — the human half too.** Packaged app launched: 1 main process + 3 renderer helpers, alive and stable, no new `DiagnosticReports` entry. `pty.node` and `spawn-helper` both in `app.asar.unpacked` |

Still unrun, unchanged from Run 1: **B1, B2, B4, B5, B7–B11** (window chrome,
browser guest and scheme guard, Cmd-key interception, quit path, single
instance), **C1–C18**, **D1–D6**. CI compiles and tests; it never opens a
window, so these remain the cases where a 15-version Chromium jump would
actually show.

### Notes

- Nothing in the merged agents code is Electron-version-sensitive — it is
  `fs`/`execSync` in the main process and plain React in the renderer — which
  is why a clean merge plus a green gate is meaningful here rather than
  coincidental.
- The `assets/bin` warning and the unsigned-build warning both reproduced
  exactly as in Run 1. Still pre-existing, still not upgrade-related.

---

## H. Run 3 — the GUI matrix, after merging `develop` again (2026-10-03, `chore/electron-43-upgrade` @ `0582969` + drop fix)

`develop` had moved 74 commits ahead (notes, project icons, keep-awake, the
right-hand explorer, Tasks/GitHub, a new `afterPack` hook) — none of it ever
run on Electron 43. This run drove the **real app** for the first time: a
Playwright `_electron` driver against `npm run dev` and then the packaged
`release/mac-arm64/WPXen.app`, clicking through the UI and reading the main
process directly. Machine: macOS 25.6.0, arm64.

**One upgrade regression found and fixed.** Electron 32 removed `File.path`,
so dropping Finder files onto the **File Explorer** (import) or an **agent
terminal** (paste path) silently did nothing — the `.filter(Boolean)` swallowed
the `undefined`s. `preload.cjs` now bridges `webUtils.getPathForFile` as
`electronAPI.pathForFile`, and both drop handlers use it. Verified with real
disk-backed Files in dev and packaged: `f.path` → `undefined`, bridged path
correct, a renderer-built `File` → `''`. The icon picker reads bytes, not
paths, and was unaffected.

| ID       |       | Note                                                                                                                                                           |
| -------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1       | ✅    | Gate green after merge and after the fix: 833 tests                                                                                                            |
| B1       | ✅    | 1200×800, traffic lights (16,18), `#151110` backdrop, tray icon present, dock hidden while hidden / shown while visible                                        |
| B2       | ✅    | `themeSource` light→dark→system: window backdrop and renderer tokens flip together                                                                             |
| B3       | ✅    | pty rooted at webroot, echo round-trips, resize reflows (48×76 → 41×54)                                                                                        |
| B4       | ✅    | Output kept arriving while hidden; scrollback intact on reopen                                                                                                 |
| B5       | ✅    | `https://kawaii.test` (mkcert) and `example.com` render; guest `sandbox`, no preload, no nodeIntegration, persistent partition; Inspect Element opens DevTools |
| B6       | ✅    | Real context menu captured from `browser.cjs`: Back on/Forward off at B; real Back item → A; flags flip                                                        |
| B7       | ✅    | `file:` typed → searched, not loaded; `javascript:` never ran; guest-initiated `file:` and meta-refresh blocked; `_blank` → new in-app tab, still one window   |
| B8       | ⚠️    | **Pre-existing, not a regression** — see below                                                                                                                 |
| B9       | ✅    | ⌘R reloads the guest only; ⌘W closes the browser tab, window stays (by design, `browser.cjs`)                                                                  |
| B10      | ✅    | Agent-running dialog → Cancel keeps the app; Quit Anyway stops nginx/PHP-FPM/MySQL, Electron gone in ~2 s, no orphans; dnsmasq (root, not ours) untouched      |
| B11      | ✅    | Second launch exits at once and re-shows the hidden window                                                                                                     |
| B12      | ✅    | Builder 26 + `afterPack`: ad-hoc signature verifies; packaged app loads from asar, **pty spawns**, guest paints, drop fix works; clean quit                    |
| B13      | ✅    | `LSMinimumSystemVersion` 12.0                                                                                                                                  |
| C3       | ✅    | Add Site wizard → 9 progress steps in 8 s; serves 200, DNS, vhost, DB                                                                                          |
| C4       | ✅    | `kill -9` nginx → procman restarts in 2 s; UI Stop/Start MySQL tracks 4→3→4                                                                                    |
| C6       | ✅    | Clone, export (37 MB, valid manifest), inspect-for-import, blueprint save + create-from: all serve with URLs rewritten                                         |
| C7       | ✅    | Three test sites removed: no dirs, vhosts or DBs left; blueprint deleted                                                                                       |
| C9       | ✅    | phpMyAdmin serves the DB structure page with no login form                                                                                                     |
| C10      | ⚠️ ✅ | HTTPS half (mkcert, in-app guest trusts it). Tunnel not run — it publishes a local site                                                                        |
| C11, C12 | ✅    | create/write/read/rename/import/trash through IPC; Changes pane lists nested-repo files; diff renders                                                          |
| C13      | ✅    | `startAtLogin` really registers/deregisters the OS login item (restored); bad key/type rejected; `settings-updated` pushed                                     |
| C14      | ✅    | "login" narrows to General/Sites/Database                                                                                                                      |
| C15      | ✅    | Cookie planted in `persist:wpxen-browser` gone after Clear                                                                                                     |
| C16      | ✅    | `file:`/`javascript:` refused; only https reached `shell.openExternal`                                                                                         |
| C18      | ✅    | nginx access/error and php-fpm logs read                                                                                                                       |
| D1       | ✅    | xterm canvas holds a live WebGL2 context; GPU compositing enabled                                                                                              |
| D3       | ✅    | CodeMirror highlighting and diff render                                                                                                                        |
| D7       | ✅    | Every top-level page visited: **zero** Electron deprecation lines, no main-process errors from app code                                                        |
| C1, C2   | ⏭     | Need a fresh profile; C2 is covered by `test/rebrand.test.js`                                                                                                  |
| C5       | ⏭     | Only PHP 8.5 installed                                                                                                                                         |
| C8       | ⏭     | Mailpit not installed                                                                                                                                          |
| C17      | ⏭     | Resolver already configured; would raise an admin prompt                                                                                                       |

### B8 is pre-existing

Re-parenting a `<webview>` mints a new guest that **reloads** — scroll, JS
state and back-history are lost. A minimal standalone repro (one webview, set a
marker, move it to another container) behaves **identically on Electron
28.3.3 and 43.4.1**, so this predates the upgrade; `webviewCache.js`'s comment
claiming the page "keeps its scroll position and JS state" has never held. Also
note `AgentsPane` deliberately disposes its browser tabs on unmount, so the
plan's "switch app section" step no longer applies — the in-pane file-tab ↔
browser-tab switch is the case that matters. File separately.

### Also seen, not upgrade-related

- `set-mail-catching` persists `mail.catch: true` even when it then fails with
  "Mailpit is not installed" (no override is written, so `mail()` is fine).
- The host CSP's `img-src` blocks `https://*.test` favicons in browser tabs.
- A URL the guest can't parse (`https://javascript:…`) surfaces as an unhandled
  `loadURL` rejection in the renderer console.

### Methodology notes

- Playwright emulates `prefers-color-scheme: light` by default — call
  `page.emulateMedia({ colorScheme: null })` or every screenshot is wrong-themed.
- Playwright's `page.screenshot` can omit a `<webview>` guest that is visibly
  painted on screen; use `webContents.capturePage()` on the guest instead.

---

## I. Run 4 — PHP switching and Mailpit (2026-10-03, `chore/electron-43-upgrade` @ `36173ff`)

Mailpit and PHP 8.4 were installed **through the app's own installers** to
unblock C5 and C8, which also exercised both install flows on Electron 43.

| ID       |       | Note                                                                                                                                                                                                                                                                          |
| -------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| installs | ✅    | `installMailpit` (9 s) and `installPhpVersion('8.4')` (26 s, 8.4.26) succeed with progress streamed on `mailpit-install-progress` / `php-install-progress`                                                                                                                    |
| C5       | ⚠️ ✅ | Global switch 8.5 ⇄ 8.4: FPM restarts on the new version, sites answer `X-Powered-By: PHP/8.4.26` / `8.5.11`; 7 of 7 repeat switches clean (3.5 s). **One earlier failure — see below**                                                                                       |
| C8       | ✅    | Catching on → Mailpit runs as an app child, `sendmail_path` override written to **both** versions' conf.d; raw `mail()`, CLI `wp_mail` and an FPM-served lost-password mail all captured; Mail page lists and reads them; catching off → overrides removed from every version |

### The one failed switch (not attributed to the upgrade)

The **first** global switch after `brew install php@8.4` failed with
`php is already running outside WPXen`, and left **no** FPM running — every
site 502 until PHP was started from Services. `switch-php-version` stops the
8.5 child, then `procman.start` runs the `conflictProbe` (`pgrep` for any
`php-fpm: master`) and, after a no-op `takeover` and 2 s, gives up. It did not
reproduce in 8 further switches, and the code path is `procman` + `pgrep` with
no Electron API, so it isn't attributed to the upgrade — but its failure mode
(PHP left stopped rather than left on the old version) is worth fixing
separately.

### Also seen, not upgrade-related

- **Per-site PHP version has no effect here.** The vhost uses a per-version
  unix socket only if one exists; brew's pools all `listen = 127.0.0.1:9000`, so
  every site is served by whichever FPM holds :9000 — i.e. the global version.
  `getPhpVersions` also reports every installed version as `running`.
- kawaii's active Brevo plugin (`mailin`) replaces `wp_mail`, so its mail never
  reaches `mail()` or Mailpit — expected, but surprising when testing there.
