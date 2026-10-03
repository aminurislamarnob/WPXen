---
name: update-wpxen-landing
description: Update the WPXen landing page (aminurislam.me/wpxen) for a new WPXen version. Use after cutting a WPXen release, or when asked to refresh the landing page's version, features, FAQ or screenshot.
---

# Update the WPXen landing page

The page lives in the **aminurislam.me** repo (Nuxt 4, branch `production`,
which deploys on push), not in WPXen. It mirrors the BurnTracker page's design
system; read that repo's `CLAUDE.md` before editing anything beyond the steps
below. Its message, in order: **a fresh Mac to a running WordPress site in one
app** (no installing Homebrew, PHP, MySQL and phpMyAdmin one by one, no Herd
or MAMP on top), then AI agents beside every site. New copy serves that order.

| What | Where (aminurislam.me repo) |
| --- | --- |
| Release facts: `version`, `requires`, download + notes URLs, SEO copy, FAQ array, schema `featureList` | `app/pages/wpxen.vue` |
| Highlights band, fresh-Mac checklist (`usualWay` / `withWpxen`), features grid, agents grid, setup steps | `app/components/Products/WPXen.vue` |
| Machine-readable summary (`Current version: …`) | `public/llms.txt` |
| Agent marks | `public/images/providers/*.svg` |
| Hero screenshot | `public/images/wpxen-app-<version-dashed>.png` |

`app/pages/wpxen.vue` is the **single source of truth** for the release: every
download URL is derived from `version`, and the component reads it through
`inject('wpxenRelease')`. A version bump is a one-constant edit there plus the
`llms.txt` line.

## Steps

### 1. Pin down the release

From the WPXen repo, confirm the release is published and carries both
installers under electron-builder's names:

```bash
gh release view v<X.Y.Z> --json isDraft,assets --jq '{isDraft, assets:[.assets[].name]}'
```

Done when it is not a draft and lists exactly `WPXen-<X.Y.Z>-arm64.dmg`
(Apple Silicon) and `WPXen-<X.Y.Z>.dmg` (Intel). The page's buttons are built
from those names; any other naming 404s them. Read the release body too
(`gh release view v<X.Y.Z> --json body`): it is the input to step 4.

### 2. Sync the site repo

```bash
cd ~/Sites/aminurislam.me 2>/dev/null || git clone https://github.com/aminurislamarnob/aminurislam.me.git ~/Sites/aminurislam.me
git -C ~/Sites/aminurislam.me checkout production && git -C ~/Sites/aminurislam.me pull --ff-only
```

Done when `git status` is clean on `production` at `origin/production`.

### 3. Bump the version

- `app/pages/wpxen.vue`: set `version`. Change `requires` only if the minimum
  macOS changed (check the WPXen release notes / `package.json` electron
  version).
- `public/llms.txt`: the `Current version:` line in the WPXen section.

Done when `git grep -n "<old version>"` in the site repo returns nothing WPXen
related. A stale screenshot filename like `wpxen-app-1-4-0.png` is expected
here and handled in step 5.

### 4. Carry the release's user-facing changes into the copy

Every user-facing item in the release notes is either reflected on the page
or consciously skipped. For each one, decide where it belongs:

- **Fresh-Mac checklist** (`withWpxen` in the component, plus the hero
  lede): must match what onboarding actually does. Re-read WPXen's
  `src/components/Onboarding.jsx` and `electron/services/setup.cjs` when a
  release touches either. Homebrew is *opened* (its installer runs in
  Terminal and asks for the user's password), never "installed for you".
- **Features grid** (`features` in the component): keep it at nine cells, a
  multiple of three, or the ruled grid leaves hanging rules. A new headline
  feature replaces the weakest existing cell rather than making a tenth.
- **FAQ** (`faq` in the page): add or update an answer when the change alters
  a fact an answer states (requirements, supported agents, PHP versions,
  pricing). Answers stand alone when quoted out of context.
- **Agents grid** (`agents` in the component): must equal the registry in
  WPXen's `electron/services/agents.cjs` (minus the plain Terminal). A new
  agent needs its mark: extract the paths from WPXen's
  `src/components/providerIcons.jsx` into a white-filled
  `public/images/providers/<id>.svg`, the way the existing ones are drawn.
- **Schema `featureList`** and the **`llms.txt`** bullets: same facts, kept in
  step with the grid and FAQ.

Every claim is verified against the WPXen code or release notes, never
inferred from a feature's name. `license` stays out of the schema until WPXen
has a LICENSE file (it declares MIT only in `package.json`).

Done when you can list each release-note item next to the edit it produced or
the reason it was skipped. Put that list in your report to the user.

### 5. Refresh the hero screenshot when the UI changed

Only when the release visibly changes the Agents window, or the user asks.
The capture is of the real app window, staged by the user:

1. Ask the user to stage WPXen as it should appear publicly: the Agents view,
   a demo project (no client names), an agent session with visible activity,
   and keep the window at its usual size. Wait for them to say it's ready.
2. Capture with [`capture-window.sh`](capture-window.sh), which finds the main
   window and grabs it without its shadow.
3. Save it under a **new** filename, `public/images/wpxen-app-<X-Y-Z>.png`,
   2000px wide (`sips -s format png --resampleWidth 2000 in.png --out out.png`),
   point both references at it (the `<NuxtImg>` in the component and
   `screenshot` in the page schema, plus the image `width`/`height` attributes
   if the aspect ratio changed), and `git rm` the old file. Assets are served
   immutable with edge caching, so overwriting a filename in place keeps the
   old bytes live after deploy.

Done when the old screenshot filename appears nowhere in the repo.

### 6. Verify

```bash
cd ~/Sites/aminurislam.me
npm install --no-audit --no-fund && git checkout package-lock.json   # install rewrites the lockfile
npm run dev -- --port 3210 &                                          # listens on 127.0.0.1 only
curl -s http://127.0.0.1:3210/wpxen | grep -o 'releases/download/[^"]*' | sort -u
curl -sI https://github.com/aminurislamarnob/WPXen/releases/download/v<X.Y.Z>/WPXen-<X.Y.Z>-arm64.dmg | head -1
curl -sI https://github.com/aminurislamarnob/WPXen/releases/download/v<X.Y.Z>/WPXen-<X.Y.Z>.dmg | head -1
```

Done when the page shows both new download paths and each URL answers `302`
(GitHub's redirect to the asset). For a visual check, render with headless
Chrome against `127.0.0.1`, not `localhost` (which resolves to IPv6 and
fails). It writes the PNG and then hangs on the dev server's live-reload
socket, so kill it once the file exists:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars \
  --user-data-dir=/tmp/wpxen-shot --window-size=1440,4200 --virtual-time-budget=8000 \
  --screenshot=/tmp/wpxen.png http://127.0.0.1:3210/wpxen &
# wait for /tmp/wpxen.png, then: pkill -f wpxen-shot
```

Below ~500px wide, headless Chrome clips the right edge of every page here,
BurnTracker's included; that is the tool, not the layout.

Stop the dev server when done.

### 7. Commit and push

Stage only the files you changed, then commit on `production` in the repo's
style (an imperative subject naming the version, e.g. *Point the wpxen page
at v1.5.0 and feature folder projects*, and a body explaining why) and push.
Pushing `production` deploys the site, so push only when the user asked for
it in this session; otherwise stop at the commit and say so.

Done when `git status` is clean and `production` matches `origin/production`.
