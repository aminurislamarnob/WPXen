# Plan: In-App Browser (Superset parity) + site-scoped phpMyAdmin

> **Status: all five phases shipped** (`eef1f6f`, `633d133`, `3f8bf0d`,
> `eb7fda5`, `7ba0b3a`). Deviations from the plan as written:
>
> - **Step 27 (console ring buffer) was dropped.** Nothing consumes it — the
>   DevTools button already covers reading a page's console — so it would have
>   shipped as dead code. The `browser-console` channel is not registered.
> - **Step 22 (mkcert HTTPS `.test`) is unverified.** Whether mkcert-issued
>   certificates validate inside the `persist:wpherd-browser` partition needs a
>   running app and an HTTPS site. No bypass was written; `BrowserErrorOverlay`
>   names the certificate case (codes -201/-501) so the failure is legible if it
>   happens. If it does, the fix is the fingerprint-scoped `certificate-error`
>   handler described in D6 — never a blanket `preventDefault()`.
> - **Steps 29–30 merged.** Rather than adding external/in-app variants of every
>   quick action, the actions resolve a URL and hand it to `useOpenLink`, which
>   the `app.openLinksIn` setting steers. That collapsed `open-wp-admin` and
>   `open-phpmyadmin` (each resolved _and_ opened) into their resolve halves.
> - **Nothing here has been exercised against a running app.** Tests, lint and
>   the renderer build pass; the webview lifecycle, key interception and drag
>   passthrough are all main-process/Electron behaviour that unit tests cannot
>   reach.

Adds a built-in browser to WPHerd's Agents screen, modelled on Superset's
browser pane (reference checkout at `reference/superset-main`), plus a
site-specific "open phpMyAdmin in the app" action.

Companion to `plans/superset-terminal-parity.md` and
`plans/superset-file-explorer-parity.md`. Same shape: analysis first, then a
phased build spec.

---

## 1. How Superset does it

Superset reference paths (all under `apps/desktop/src/`):

| Concern             | File                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------- |
| Enable webviews     | `main/windows/main.ts:124` — `webPreferences.webviewTag: true`                            |
| Main-process owner  | `main/lib/browser/browser-manager.ts` (313 lines)                                         |
| IPC surface         | `lib/trpc/routers/browser/browser.ts` (209 lines)                                         |
| Renderer lifecycle  | `.../TabView/BrowserPane/hooks/usePersistentWebview/usePersistentWebview.ts`              |
| Pane component      | `.../TabView/BrowserPane/BrowserPane.tsx`                                                 |
| Toolbar             | `.../BrowserPane/components/BrowserToolbar/BrowserToolbar.tsx` (+ `UrlSuggestions`)       |
| Error overlay       | `.../BrowserPane/components/BrowserErrorOverlay/`                                         |
| Teardown            | `.../WorkspaceView/hooks/useBrowserLifecycle/useBrowserLifecycle.ts`                      |
| History persistence | `lib/trpc/routers/browser-history/`, `packages/local-db/drizzle/0026_browser_history.sql` |
| User docs           | `apps/docs/content/docs/browser.mdx`                                                      |

### The architecture in one paragraph

The **renderer** owns the `<webview>` element. It creates it imperatively
(`document.createElement("webview")`), stores it in a module-level
`Map<paneId, WebviewTag>`, and on React unmount **re-parents it into a hidden
off-screen container** rather than destroying it — so a browser tab keeps its
page, scroll position, cookies and JS state when you switch tabs. On remount it
is `appendChild`-ed back into the live container. This is byte-for-byte the same
pattern WPHerd already uses for terminals in `src/lib/terminal/sessionCache.js`
(whose header comment already calls it "Superset's hide attach pattern").

The **main process** never owns the view; it only gets handed a
`webContentsId` on `dom-ready` and uses `webContents.fromId()` to attach the
things a renderer cannot do: native context menu, console capture,
`setWindowOpenHandler`, `before-input-event` key interception, DevTools,
`capturePage`, `executeJavaScript`, and session/cache clearing.

Navigation state (current URL, title, favicon, history array + index, loading,
error) lives in the **renderer store**, fed by webview DOM events
(`did-start-loading`, `did-stop-loading`, `did-navigate`,
`did-navigate-in-page`, `page-title-updated`, `page-favicon-updated`,
`did-fail-load`). Back/forward navigate that store's own history array and
`loadURL()` the result, guarded by an `isHistoryNavigation` ref so the
resulting events don't push duplicate entries.

### Notable details worth copying

- **`sanitizeUrl`** exists in _both_ processes (identical logic): `http(s)://`
  and `about:` pass through; bare `localhost`/`127.0.0.1` get `http://`;
  anything containing a `.` gets `https://`; everything else becomes a Google
  search. (`browser-manager.ts:13`, `usePersistentWebview.ts:78`.)
- **`before-input-event`** (`browser-manager.ts:247`) — when a webview has
  focus, keystrokes go to the guest renderer, so host key listeners _and_ the
  app menu's accelerators never see them. Intercepting in the main process is
  the only way to make Cmd+W close the pane instead of the window, and Cmd+R
  reload the page instead of the app. Guards on `keyDown` only, and skips when
  Shift/Alt are held.
- **Drag passthrough** (`usePersistentWebview.ts:44`) — webviews are separate
  compositor layers that swallow drag events. Global capture-phase
  `dragstart`/`dragend`/`drop` listeners flip `pointer-events: none` on every
  registered webview so drop targets underneath still work. WPHerd's
  `react-resizable-panels` divider has the same problem with plain mouse drags.
- **`setBackgroundThrottling(true)`** so parked off-screen webviews don't run
  at full speed.
- **Re-registration on `dom-ready`** — `getWebContentsId()` changes when the
  element is reparented across DOM trees, so the hook compares against a
  `registeredWebContentsIds` map and re-registers when it differs. The manager's
  `register()` is idempotent (it tears down prior listeners even when the id is
  unchanged).
- **`did-fail-load` ignores `errorCode === -3`** (ERR_ABORTED) — that fires on
  every ordinary redirect/cancel.
- **New windows** (`target="_blank"`, `window.open`) are denied by
  `setWindowOpenHandler` and re-emitted to the renderer, which opens them as a
  new browser pane instead.

---

## 2. What WPHerd has today

- `src/components/AgentsPane.jsx` — a 3-column `PanelGroup`:
  explorer (`FileExplorer`) │ terminal column (tab strip + `Terminal`) │ editor
  column (`CodeEditor`, mounted only when `openFiles.length > 0`).
  Editor tabs are `{ key, kind: 'file' | 'diff', … }` in `openFiles`, with
  `activeKey` selecting one.
- `electron/services/phpmyadmin.cjs` — **already complete**. Installs
  phpMyAdmin via Homebrew, writes `config.inc.php` with `auth_type = 'config'`
  (auto-login), serves it at `http://phpmyadmin.test` via nginx + PHP-FPM, and
  `getUrl(dbName)` returns a deep link straight to a site's database.
- `ipc.cjs:1478` `open-phpmyadmin` → validates the DB name, `ensureReady()`,
  then `openExternalSafely(url)` — i.e. it currently **always leaves the app**.
  Surfaced as a quick action in `SiteCard.jsx:196` and `SiteDetail.jsx:187`.
- IPC is plain `ipcMain.handle` + a `contextBridge` wrapper in `preload.cjs`,
  with a `VALID_EVENT_CHANNELS` allowlist for pushed events.
- `main.cjs:44` `webPreferences` has **no `webviewTag`** — webviews are
  currently disabled.
- Persistence is `JsonStore` (`electron/store.cjs`), dotted key paths, backed by
  `userData/wpherd-data.json`. There is no SQLite, so browsing history goes here.

### Gap list

Everything. There is no browser surface of any kind; `openSiteInBrowser` and
the phpMyAdmin action both shell out to Safari/Chrome.

---

## 3. Design decisions for WPHerd

**D1 — `<webview>` tag, not `WebContentsView`.**
`WebContentsView` requires the main process to track and sync pixel bounds
against a React layout; with `react-resizable-panels` driving the Agents
columns that means a resize-observer round-trip per frame. `<webview>` lays out
as a normal DOM element. Superset chose the same. Cost: we must enable
`webviewTag`, which is off by default for security — mitigated by D5.

**D2 — The browser is a tab kind in the existing editor column, not a 4th panel.**
Add `kind: 'browser'` to `openFiles` alongside `'file'` and `'diff'`.
`CodeEditor.jsx` already renders the tab strip, close buttons and `activeKey`
switching; a browser entry just renders `<BrowserPane>` instead of the editor
body. This reuses the column, its `ResizeHandle`, the `editorOpen` conditional
and the `autoSaveId` layout persistence — no new panel plumbing, and it lands
the browser side-by-side with the agent terminal exactly like Superset.

> _Alternative considered:_ a dedicated 4th `Panel`. Rejected — it costs a new
> `autoSaveId` layout variant for every combination of explorer/editor/browser
> visibility, and users would end up with three narrow columns on a laptop.

Because the parked-webview registry keeps the page alive while a _different_
editor tab is active, switching between a file and the browser is free.

**D3 — Reuse the terminal cache pattern verbatim.**
`src/lib/browser/webviewCache.js` mirrors `src/lib/terminal/sessionCache.js`:
`getOrCreate` / `attach` / `detach` / `dispose`, module-level `Map`, hidden
container. Same mental model for anyone who has read the terminal code.

**D4 — Browser state lives in `AgentsPane`, not a global store.**
WPHerd has no Zustand; state is React `useState` in `AgentsPane`. Per-tab
browser state (`url`, `title`, `favicon`, `history[]`, `historyIndex`,
`loading`, `error`) is a `browserState` map keyed by tab key, owned by
`AgentsPane` and threaded down. Keeps it consistent with how `titles` and
`openFiles` already work.

**D5 — Security hardening beyond what Superset does.**
Enabling `webviewTag` means any XSS in our own renderer could mint a webview
with `nodeIntegration`. Add a `will-attach-webview` handler in `main.cjs` that
force-deletes `webPreferences.preload`, forces `nodeIntegration: false` /
`contextIsolation: true`, and rejects any `src` that isn't `http:`/`https:`/
`about:blank`. Cheap, and it means the attack surface doesn't grow.

**D6 — mkcert HTTPS `.test` sites.**
Chromium on macOS consults the system trust store, and `mkcert.cjs` installs its
root CA there, so HTTPS `.test` sites should validate. If they don't (the
webview's `persist:wpherd` partition validates independently), add a narrowly
scoped `certificate-error` handler that only trusts errors whose hostname ends
in `.test` **and** whose fingerprint matches the mkcert root — never a blanket
`event.preventDefault()`. Verify empirically in Phase 3 before writing any
bypass.

**D7 — History in `JsonStore`, capped.**
`browser.history` → array of `{ url, title, faviconUrl, visitedAt, visits }`,
deduped by URL, capped at 500, most-recent-first. No new dependency.

---

## 4. Phased build spec

### Phase 1 — Foundation: a browser tab you can type a URL into

**Main process**

1. `electron/main.cjs:44` — add `webviewTag: true` to `webPreferences`.
2. `electron/main.cjs` — add the `will-attach-webview` hardening from D5 on
   `mainWindow.webContents`.
3. New `electron/services/browser.cjs` — port of `browser-manager.ts`, as a
   CommonJS module exporting a singleton over an `EventEmitter`:
   - `register(tabKey, webContentsId)` / `unregister(tabKey)` / `unregisterAll()`
   - `getWebContents(tabKey)` (null-safe, `isDestroyed()` guarded)
   - `navigate`, `reload(hard)`, `openDevTools`, `screenshot`, `evaluateJS`
   - `sanitizeUrl(url)` — exported for tests, and for the renderer copy to be
     kept in sync
   - listener maps + idempotent teardown, exactly as Superset does
   - `setBackgroundThrottling(true)` on register
4. `electron/ipc.cjs` — handlers: `browser-register`, `browser-unregister`,
   `browser-navigate`, `browser-reload`, `browser-open-devtools`.
   Call `browser.unregisterAll()` from the existing quit path.

**Preload**

5. `electron/preload.cjs` — a `browser*` method group, and add
   `browser-new-window`, `browser-context-menu-action`, `browser-close-tab`,
   `browser-reload-tab`, `browser-console` to `VALID_EVENT_CHANNELS`.
   Push events carry `{ tabKey, … }` so a single channel serves all tabs
   (WPHerd has no per-subscription IPC like tRPC observables — filter by
   `tabKey` in the hook, the way `sessionCache.js` filters `terminal-data`).

**Renderer**

6. New `src/lib/browser/sanitizeUrl.js` — the shared URL heuristic. Unit-tested.
7. New `src/lib/browser/webviewCache.js` — the persistent registry (D3):
   `getOrCreate(tabKey, initialUrl, handlers)`, `attach`, `detach`, `dispose`,
   hidden-container parking, drag-passthrough listeners.
8. New `src/components/browser/BrowserPane.jsx` — toolbar + webview container +
   empty state. Empty state uses `IconTile`/`Globe`, matching the "No sessions
   yet" panel already in `AgentsPane.jsx:446`.
9. New `src/components/browser/BrowserToolbar.jsx` — back / forward / reload
   (spinner while loading) / URL field. Use `.form-input` and the existing
   `Tooltip`; icon buttons match the tab-strip buttons in `AgentsPane.jsx:355`
   (`p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent`).
10. `src/components/AgentsPane.jsx` — `openBrowser(url)` pushes
    `{ key: 'browser:<n>', kind: 'browser', url }` into `openFiles`; add a
    `browserState` map + updater callbacks.
11. `src/components/CodeEditor.jsx` — render `<BrowserPane>` for
    `kind === 'browser'` tabs; use a `Globe` icon in the tab strip.
12. On tab close (existing `closeFile`) → `webviewCache.dispose(key)` +
    `browserUnregister(key)`. Also dispose every browser tab when `siteId`
    changes (`AgentsPane.jsx:103` already clears `openFiles`).

**Acceptance:** open a browser tab from the editor tab strip, type
`wpherd.test`, page loads; switch to a file tab and back — the page is still
scrolled where you left it and did not reload.

**Tests:** `test/browser-sanitize-url.test.js` (bare host, localhost, IP, search
fallback, `about:blank`, existing scheme); `test/browser-manager.test.js`
(register is idempotent and tears down prior listeners; unregister clears maps;
`getWebContents` on a destroyed contents returns null) with `electron` stubbed
the way `test/settings.test.js` stubs its deps.

---

### Phase 2 — Site targets, including phpMyAdmin

13. `electron/ipc.cjs` — new `get-phpmyadmin-url` handler: same DB-name
    validation and `ensureReady()` as `open-phpmyadmin` (extract the shared
    body), but **returns** `{ success, url }` without `openExternalSafely`.
    Leave `open-phpmyadmin` untouched so the existing external quick actions
    keep working.
14. `electron/preload.cjs` — `getPhpMyAdminUrl(dbName)`.
15. `src/components/AgentsPane.jsx` — the site load effect
    (`AgentsPane.jsx:61`) currently keeps only `name` and `path`; also keep
    `url`, `dbName` and `https`.
16. New "Open in browser" split button in the terminal column's tab strip,
    next to the `+` and `Settings2` buttons, with a menu (same fixed-position
    `.panel` pattern as `addMenu`, `AgentsPane.jsx:377`):
    - **Site** → `site.url`
    - **WP Admin** → `${site.url}/wp-admin`
    - **phpMyAdmin** → `await getPhpMyAdminUrl(site.dbName)` — lands directly
      on this site's database, auto-logged-in
    - **Mailpit inbox** → `http://localhost:8025`
    - separator
    - **Blank tab**
      phpMyAdmin's entry shows a spinner while `ensureReady()` runs (first use
      may `brew install phpmyadmin`), and surfaces failures through the existing
      `error` state at `AgentsPane.jsx:426`.

**Acceptance:** on a site with a database, the phpMyAdmin menu item opens an
in-app tab already sitting on that site's table list, with no login screen.

**Tests:** extend `test/mysql.test.js`-style coverage with a
`test/phpmyadmin.test.js` asserting `getUrl()` encodes the DB name and that the
IPC-level validation regex rejects `foo;drop`, `../`, and >64 chars.

---

### Phase 3 — Robustness parity

17. `did-fail-load` → error overlay component (`BrowserErrorOverlay.jsx`) with
    a Retry button; ignore `errorCode === -3`.
18. `setWindowOpenHandler` → `browser-new-window` event → open a **new browser
    tab** in the same column.
19. Native context menu in `browser.cjs` (Open in Default Browser / Copy Link /
    Copy Page URL / Back / Forward / Reload). Route "Open in Default Browser"
    through the existing `openExternalSafely` in `ipc.cjs` — do not add a second
    external-open path.
20. `before-input-event`: Cmd+W → close _this_ browser tab, Cmd+R → reload the
    page, and forward Cmd+B / Cmd+[ / Cmd+] so `Layout.jsx:58`'s shortcuts still
    fire while a webview has focus.
21. Drag passthrough so the `ResizeHandle` between columns still works when a
    webview is mounted (add `mousedown`/`mouseup` alongside the HTML5 drag
    events — `react-resizable-panels` uses pointer events, not HTML5 drag).
22. Verify HTTPS `.test` sites (D6) and implement the scoped
    `certificate-error` fallback only if they actually fail.

**Acceptance:** dragging the column divider over a loaded page works; Cmd+W in a
focused webview closes the browser tab, not the window; a broken URL shows the
overlay instead of a blank pane.

---

### Phase 4 — History, autocomplete, DevTools, console

23. `electron/services/settings.cjs` (or a small `browserHistory` section in
    `store.cjs`) — `browser.history` list per D7, with `upsert(url, title,
favicon)` and `clear()`. IPC: `browser-history-search`,
    `browser-history-clear`.
24. URL-field autocomplete dropdown (`UrlSuggestions`) — arrow keys, Enter,
    Escape, matching Superset's `useUrlAutocomplete`. Reuse the popover styling
    from `.panel`.
25. Favicon in the tab strip and the URL field, fed by `page-favicon-updated`.
26. DevTools button in the browser toolbar → `openDevTools({ mode: 'detach' })`.
27. Console capture in `browser.cjs` (ring buffer, 500 entries) pushed on
    `browser-console`. Useful in its own right, and the groundwork for later
    letting an agent read the page's console.
28. Settings → a **Browser** section (or a row under an existing section) with
    "Clear browsing history", "Clear cookies & cache". Register the rows in
    `src/lib/settingsRegistry.js` so they're searchable, and add the schema keys
    in `electron/services/settings.cjs`.

**Tests:** `test/browser-history.test.js` — dedupe by URL, visit-count
increment, 500-entry cap, most-recent-first ordering, prefix + substring search
ranking.

---

### Phase 5 — Wire the rest of the app into it

29. `SiteCard.jsx` / `SiteDetail.jsx` — the phpMyAdmin, Site and WP Admin quick
    actions gain an "Open in WPHerd" variant that navigates to
    `/agents/<siteId>` with `location.state.openBrowser = url`, which
    `AgentsPane`'s existing location-state effect (`AgentsPane.jsx:81`) honours
    the same way it honours `spawn`.
30. A `general.openLinksIn` setting — `'system' | 'app'` (default `'system'`,
    so nothing changes for existing users) — consulted by `open-in-browser`,
    `open-wp-admin` and `open-phpmyadmin`.
31. `sessionCache.js:104` — the terminal's Cmd+click `WebLinksAddon` currently
    calls `openSiteInBrowser`; route it through the same setting so agent output
    links can open in-app.
32. `README.md` — a short "In-app browser" section, mirroring
    `apps/docs/content/docs/browser.mdx`.

---

## 5. Risks

| Risk                                                                      | Mitigation                                                                                                |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `webviewTag: true` widens the renderer's attack surface                   | D5 `will-attach-webview` hardening; scheme allowlist                                                      |
| `<webview>` is officially discouraged by Electron and could be deprecated | Isolated behind `webviewCache.js` + `BrowserPane.jsx`; a future `WebContentsView` port touches only those |
| Parked webviews keep pages (and their JS timers) alive → memory growth    | `setBackgroundThrottling(true)`; dispose on tab close and on site change; consider a cap on browser tabs  |
| mkcert HTTPS `.test` certs rejected inside the `persist:wpherd` partition | Verify first (Phase 3, step 22); only then a fingerprint-scoped `certificate-error` handler               |
| First phpMyAdmin open runs `brew install phpmyadmin` and blocks           | Spinner in the menu item + error surfaced in the pane; `ensureReady()` is already idempotent              |
| Webview swallows the column-resize drag                                   | Step 21 pointer-events passthrough                                                                        |

---

## 6. Sequencing

Phases 1 and 2 are the user-visible deliverable — a browser in the Agents screen
plus one-click site-scoped phpMyAdmin — and are worth shipping together. Phase 3
is required before it feels finished. Phases 4 and 5 are independent
follow-ups and can land in either order.
