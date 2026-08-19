# Plan: File Explorer & Changes tab — Superset parity

Implementation spec for bringing WPXen's Agents-screen file explorer and git
Changes tab up to feature parity with Superset (reference checkout at
`reference/superset-main`, see
`apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/components/WorkspaceSidebar/`
— `FilesTab/` and `hooks/useChangesTab/`). Written so a fresh session can
implement it without re-reading the reference app.

Read `CLAUDE.md` first — the IPC three-touchpoint pattern, dark-mode rules,
and `.panel` conventions there are binding. Then read these files fully before
editing them:

- `src/components/FileExplorer.jsx` — the whole surface being changed (tabs,
  tree, `ChangesView`, `TabButton`, `MenuItem` live here).
- `src/components/AgentsPane.jsx` — hosts the explorer + terminal + editor
  panes; owns `openFiles` / `activeFile` editor-tab state.
- `src/components/CodeEditor.jsx` — CodeMirror 6 editor (via
  `@uiw/react-codemirror`); gets a new "diff tab" mode in Phase 3.
- `electron/services/git.cjs` — read-only git backend; reworked in Phase 1.
- `electron/services/files.cjs` — has `assertInRoot(rootPath, targetPath)`,
  the path-confinement helper every new file-touching IPC must use.
- `electron/ipc.cjs` (explorer section, ~line 195+) and
  `electron/preload.cjs` — the other two IPC touchpoints.

## Hard constraints (do not violate)

1. **Never commit `electron/services/brew.cjs`** — it carries an unrelated
   pre-existing local change and must stay unstaged. Stage files explicitly
   by name; never `git add -A` / `git add .`.
2. **Never commit `reference/`** (gitignored Superset checkout).
3. **Every filesystem/git IPC is confined to the site root.** Any handler
   that takes a path must resolve it through `files.assertInRoot()` (or the
   equivalent `path.resolve` + prefix check already used in `git.cjs`).
4. **Phases 1–3 and 5 are strictly read-only for git.** Only Phase 4
   introduces mutating git commands, and it is opt-in — do not build it
   unless explicitly asked to proceed with Phase 4.
5. Renderer styling: follow `CLAUDE.md` dark-mode rules — grays need no
   `dark:` variants; literal colors (green/red/amber tints) do; menus and
   dialogs use `.panel`, never raw `bg-white`.
6. Main-process changes require an Electron restart; renderer changes
   hot-reload via Vite. Dev stack: `npm run dev`. Tests: `npm run test`
   (vitest, tests live in `test/`, cover `electron/services` logic).
   Lint: `npm run lint`.

## Current state (already shipped)

- Files/Changes tab bar at the top of `FileExplorer` (`TabButton` with count
  badge on Changes). When the app sidebar is collapsed, the tab bar gets
  `paddingLeft: 190` via the `insetForControls` prop to clear the floating
  window controls — preserve this behavior in any restructure.
- Files tab: lazy directory tree (`listDirectory` IPC per folder), search
  filter, toolbar (new file/folder, refresh, collapse-all), context menu
  (open, reveal in Finder, copy path/relative path, rename, delete via
  `window.confirm`).
- Changes tab: `gitStatus(rootPath)` IPC → flat file list with branch header,
  refresh button, `N files +x −y` totals, per-file status letter (M/A/D/R/C/U)
  - `+/-` counts. Deleted files struck through and disabled. Fetches only
    when the tab is opened.
- `git.cjs` returns
  `{ isRepo, branch, files: [{ path, rel, name, status, staged, additions,
deletions }], additions, deletions }` — one entry per file, staged and
  unstaged merged.

---

## Phase 1 — Changes list parity (read-only)

### 1a. Rework `electron/services/git.cjs` → per-source entries

Superset groups the changeset into **Unstaged** and **Staged** sections; a
partially-staged file appears in _both_. Replace the merged-entry model:

```
gitStatus(rootPath) → {
  isRepo: boolean,
  branch: string,               // 'HEAD' when detached
  files: [{
    path: string,       // absolute (root + '/' + rel)
    rel: string,        // repo-relative, POSIX separators
    name: string,       // basename
    oldRel: string|null,// pre-rename path (staged R/C only), else null
    status: 'M'|'A'|'D'|'R'|'C'|'?',
    source: 'staged'|'unstaged',
    additions: number,
    deletions: number,
  }],
  additions: number,    // totals across all entries
  deletions: number,
}
```

Parsing rules (porcelain v1, line = `XY rest`):

- `??` → one entry: `source:'unstaged'`, `status:'?'`.
- `X` (index column) not `' '` and not `'?'` → a **staged** entry with
  `status = X`. For `R`/`C`, `rest` is `old -> new`: key off `new`, set
  `oldRel = old`. Strip surrounding quotes from both (git quotes unusual
  bytes) — keep the existing `replace(/^"|"$/g, '')` approach.
- `Y` (worktree column) not `' '` → an **unstaged** entry with `status = Y`.
- A line like `MM file` therefore yields two entries (one per section),
  matching Superset.

Numstat maps stay **separate** (no longer merged): `git diff --numstat` →
unstaged counts, `git diff --cached --numstat` → staged counts. Attach each
entry's counts from its own map (rename numstat paths appear as
`old => new` / `{a => b}/c` brace form — if the exact rel key is missing,
fall back to `{additions:0, deletions:0}`; don't try to fully parse brace
renames).

Untracked files get `additions` = the file's line count (read the file,
`content.split('\n').length`, but return 0 if the buffer contains a NUL byte
in the first 8000 bytes — binary). Cap reads at ~2 MB; larger/unreadable → 0. This matches Superset showing `+N` for new files.

Keep `run()` resolving `null` on error and the whole function never throwing.
**Update `test/` vitest coverage**: pure-parse the porcelain/numstat handling
(extract a `parseStatus(statusOut, unstagedNumstat, stagedNumstat)` helper so
it's testable without spawning git). Cases: plain `M`, `MM` (two entries),
`??`, staged rename `R  old -> new`, quoted path, binary `-` numstat, empty
output.

The renderer is the only consumer (`FileExplorer.jsx`) — update it in the
same commit; no compatibility shim needed.

### 1b. Row layout (match Superset's `FileRow`)

Order per row, left→right:

1. File-type icon (`FileGlyph` from `src/lib/fileIcons`).
2. Muted directory prefix **before** the name: `wp-content/themes/` in
   `text-gray-500`, truncating from the left is not needed — simple
   `truncate` on the dir span, `min-w-[120px]` on the basename span so the
   name survives truncation (Superset does exactly this).
3. For renames (`oldRel` set): muted `oldBasename →` before the bold new
   basename.
4. Bold basename (`text-gray-800 font-medium`).
5. Right side: `+a −d` counts (`text-green-500` / `text-red-500`,
   `dark:text-green-400 dark:text-red-400`, `tabular-nums`), then a **status
   dot** — an 8px `rounded-full` span colored by status (replaces the letter):
   M amber-500, A/? green-500, D red-500, R/C blue-400. Add
   `title={statusLabel}` ("Modified", "Added", "Deleted", "Renamed",
   "Copied", "Untracked") for discoverability.
6. Deleted rows: keep strike-through + disabled click.
7. Row click: opens the file in the editor (until Phase 3 swaps this to the
   diff). `title` tooltip = `rel`.

### 1c. Sections (Unstaged / Staged)

Group `files` by `source`. Render order: **Unstaged first, then Staged**
(Superset's order), each as a collapsible section:

- Header row: chevron (ChevronDown/Right, 13px), label
  (`text-[11px] font-semibold uppercase tracking-wide text-gray-500`), count
  badge (same pill style as the tab badge). Clicking toggles collapse.
- Empty sections are omitted entirely.
- Section collapse state is component state (resets on site change — fine).

### 1d. Header + toolbar restructure

Keep the branch header (GitBranch icon + branch name). Below it, a toolbar
line matching Superset's `ChangesToolbar`:

- Left: `N files` + `+x` `−y` totals (`text-[11px] text-gray-500`).
- Right icon cluster (reuse the `iconBtn` class already in the file):
  - **View-mode toggle** (Phase 2 — render in Phase 1 as a no-op-hidden or
    just add it in Phase 2).
  - **Refresh** (RefreshCw, `animate-spin` while loading) — moves here from
    the branch line.
  - **Collapse/expand all** (FoldVertical / UnfoldVertical): toggles all
    sections (and, in Phase 2, all folder groups / tree dirs). Implement as
    a `foldSignal` state `{ epoch, action: 'collapse'|'expand' }` passed
    down; children apply it in an effect keyed on `epoch`. Track `collapsed`
    boolean in the parent to know which icon/action to show next.

### 1e. Freshness

- Refetch on `window` focus while the Changes tab is active.
- Poll every 5 s while the Changes tab is visible (clear the interval when
  the tab switches away or the component unmounts). Guard against overlap:
  skip a tick if a fetch is in flight.
- Keep the existing badge on the Changes tab (`files.length` — now counts
  entries, which may double-count partially-staged files; that matches
  Superset, whose badge is the changeset row count).

**Acceptance:** in a site with a git repo, `touch new.php`, edit a tracked
file, `git add` one of them → Unstaged and Staged sections appear with
correct rows, dots, counts; totals update within 5 s without pressing
refresh; non-repo site shows the existing "not a git repository" state.

---

## Phase 2 — View modes (Folders / Tree)

Superset has two render modes inside each section, toggled by one button
that shows the mode it will switch **to** (Folder icon ↔ ListTree icon,
`title` "Folder view"/"Tree view").

### Folders view (default)

Flat groups by parent directory, per section:

- Group rows by `dirOf(rel)` (`''` for root files). Sort groups: root group
  first, then alphabetical. Files within a group alphabetical.
- Each group gets a collapsible folder-header row: chevron + Folder icon +
  dir path (muted, truncate) + count. Root-level files go in a group
  labeled with the site name or just no header (Superset labels it `/` —
  use no header for root, simpler and cleaner).
- File rows inside a group hide their dir prefix (`hideDir`) since the
  header shows it.

### Tree view

Full directory hierarchy built from the section's `rel` paths:

- Build a nested node map (`{ dirs: Map, files: [] }`) by splitting `rel`
  on `/`. **Compress single-child directory chains** into one row
  (`wp-content/themes/twentytwentyfive` as one entry) — Superset's tree
  does this; it keeps WP paths shallow.
- Dir rows: chevron + Folder icon + segment name; collapsible.
- File rows: `hideDir`, indented `depth * 12 + 8` px like the Files tree.

### Shared

- Persist mode in `localStorage` key `wpxen.changesViewMode`
  (`'folders'|'tree'`), read once on mount.
- `foldSignal` from Phase 1 collapses/expands folder groups (folders view)
  or directory nodes (tree view) in addition to the sections.

**Acceptance:** toggle switches modes and survives app reload; fold-all
collapses groups/dirs in both modes; a change in
`wp-content/plugins/foo/foo.php` shows a compressed
`wp-content/plugins/foo` node in tree view.

---

## Phase 3 — Diff viewer

The flagship gap: clicking a changed file opens a **diff**, not the raw
file. Superset renders diffs in a pane; WPXen renders them as a special
editor tab in `CodeEditor`.

### 3a. Dependency

`npm i @codemirror/merge` (CodeMirror 6 first-party; compatible with
`@uiw/react-codemirror` — pass `unifiedMergeView` in `extensions`).

### 3b. New IPC: `git-file-at` (read-only)

Rather than parsing unified-diff text, fetch the two document versions and
let `@codemirror/merge` compute chunks:

- `git.cjs`: `fileAt(rootPath, rel, rev)` where `rev ∈ {'HEAD','index'}` →
  `git show HEAD:<rel>` / `git show :0:<rel>` via the existing `run()`.
  Returns `{ content }`; `{ content: '' }` when the file doesn't exist at
  that rev (added/untracked); `{ binary: true }` if output contains a NUL
  byte. Reject `rel` containing `..` segments and absolute paths (defense
  in depth on top of `-C root`), and cap at `maxBuffer` (already 16 MB).
- `ipc.cjs`: `ipcMain.handle('git-file-at', …)` with try/catch →
  `{ ok, content, binary }` or `{ error }`.
- `preload.cjs`: `gitFileAt: (rootPath, rel, rev) => ipcRenderer.invoke(…)`.

### 3c. Diff tabs in `AgentsPane` / `CodeEditor`

- `openFiles` entries gain a `kind` field: `'file'` (default) or `'diff'`,
  plus `rel` and `source` (`'staged'|'unstaged'`) for diff tabs. Key diff
  tabs as `diff:<source>:<rel>` so a file tab and its diff coexist; opening
  the same diff twice focuses the existing tab.
- `CodeEditor` diff-tab branch:
  - **Unstaged diff:** original = `gitFileAt(rel,'index')` _if the file is
    also staged_, else `gitFileAt(rel,'HEAD')`; modified = `readFile`
    worktree content. (Simplification: always diff against `'HEAD'` unless
    a staged entry for the same `rel` exists — pass a `hasStagedTwin` flag
    from the changes list.)
  - **Staged diff:** original = `gitFileAt(rel,'HEAD')`, modified =
    `gitFileAt(rel,'index')`.
  - **Untracked:** original = `''`, modified = worktree.
  - **Deleted:** original = HEAD/index version, modified = `''` — deleted
    rows become clickable again (they open a diff, not a file).
  - Render CodeMirror read-only with
    `unifiedMergeView({ original, mergeControls: false, highlightChanges: true })`
    - the existing `languageFor(name)` extensions and theme. Binary or
    > 2 MB → centered "Binary file / too large to diff" placeholder.
  - Tab strip: diff tabs show the file icon + name + a small `±` or
    GitCompare glyph to distinguish them from plain file tabs; no dirty-dot
    logic (read-only).
- Changes row click → open diff tab. Row context menu (new, reuse the
  `.panel` fixed-position menu pattern from the Files tree): **Open Diff**,
  **Open File**, **Copy Path**, **Copy Relative Path**, **Reveal in
  Finder**. (No "Open in Editor"/external — WPXen has no external-editor
  concept.)
- Refresh behavior: when the changes poll detects a file's counts changed
  and its diff tab is active, re-fetch that diff's documents (cheap:
  compare `additions+deletions` per rel between polls).

**Acceptance:** modified file → unified diff with red/green chunks in both
light/dark themes; staged vs unstaged rows of an `MM` file show different
diffs; untracked shows all-green; deleted shows all-red; binary shows
placeholder; plain file open still works from the Files tab.

---

## Phase 4 — Mutating git actions (GATED — requires explicit user approval)

Do **not** implement alongside 1–3. When approved:

- `git.cjs` additions (each confined + validated like `fileAt`):
  `stage(root, rels)` → `git add -- <rels>`; `unstage(root, rels)` →
  `git restore --staged -- <rels>`; `discard(root, rel, status)` →
  untracked: move to Trash via `shell.trashItem` (not `git clean`);
  tracked: `git restore -- <rel>`.
- IPC/preload: `git-stage`, `git-unstage`, `git-discard`.
- UI (mirrors Superset's `FileRow` hover actions + `ChangesSection` header
  actions): per-row hover reveals Discard (Undo2 icon; Trash2 for
  untracked/added) and Stage/Unstage (+/−); section headers get
  stage-all/unstage-all. Discard always goes through a `.panel` confirm
  dialog: "Discard changes to X? / This will revert all changes. This
  action cannot be undone." (delete wording for untracked). Refetch status
  after every mutation.

## Phase 5 — Files-tree git decorations + polish

- Lift `changes` state up so the Files tab can see it (it already lives in
  `FileExplorer` — just reuse; also run the poll while the Files tab is
  active, or reuse the last fetch + window-focus refetch).
- Build `Map<rel, status>` and a `Set` of ancestor dirs of changed files.
  In the Files tree: tint changed file names (M amber-600/`dark:amber-400`,
  A/? green-600/`dark:green-400`, D red strike) and give ancestor folders a
  small trailing dot (`bg-amber-500`, 6px). Root entries need
  `relTo(rootPath, entry.path)` to look up.
- Replace the `window.confirm` delete in the Files tree with a `.panel`
  confirm dialog (same component as Phase 4's, so build it standalone:
  `ConfirmDialog({ title, description, confirmLabel, danger, onConfirm,
onCancel })` in `src/components/ui.jsx`).

## Explicitly out of scope (Superset features tied to their worktree/PR product)

Base-branch selector ("from main") + against-base/committed sections,
commit-filter dropdown, branch rename, Review/PR tab, drag-drop file
upload, virtualized tree, external-editor integration.

## Sequencing & verification

Implement as separate commits per phase (1a+1b+1c+1d+1e together is fine as
one commit). After each phase: `npm run test`, `npm run lint`, and a manual
pass in `npm run dev` against a real site repo (create scratch changes with
plain `git`/`touch` in the site dir — never in the WPXen repo itself).
Commit messages: `feat(agents): …` style, matching the existing history.
