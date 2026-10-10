# Implementing a ticket

A ticket is a GitHub issue labelled `ready-for-agent`. Each one is a vertical slice: when it lands, one behaviour works end to end and can be checked against its acceptance criteria. Work one ticket per session, on its own branch.

Every step below ends on a **done when** line. Move to the next step only when that line is true.

## 1. Load the ticket

```bash
gh issue view <N> --comments
gh issue view <parent> # the "## Parent" spec named in the ticket
```

Read the whole ticket, its parent spec, and the **Implementation notes** comment if there is one. The notes name the files, functions and prior art for this ticket as of the commit they cite. Code that has moved since then is authoritative, so re-find it rather than trusting a stale line number.

Check every issue under **Blocked by** is closed: `gh issue view <B> --json state`.

**Done when:** every blocker is closed, and you can name the behaviour this ticket delivers and every acceptance criterion it must satisfy.

## 2. Branch

```bash
git fetch origin && git switch -c feat/<N>-<short-slug> origin/develop
```

**Done when:** you are on a fresh branch cut from the latest `origin/develop`.

## 3. Map the code

Open every file the notes name and read the surrounding code, not just the named function. For anything that crosses the process boundary, trace the full path: service module → `electron/ipc.cjs` handler → `electron/preload.cjs` method (and event channel whitelist) → renderer call site.

**Done when:** you have a written list of every file you will create or modify, with one line each saying why.

## 4. Write the failing tests first

Tests go at the seam the ticket's spec names, which is usually one of these two:

- **The Session engine** (`electron/services/agents.cjs`), driven through `__setDeps` with a fake pty and a temp home. The prior art is `test/agents-floating.test.js`.
- **A pure renderer module** in `src/lib/`. The prior art is `src/lib/floatingWorkspace.js` with `test/floating-workspace.test.js`.

Assert observable behaviour: the rows listed, the bytes written to the pty, the command line typed, the tabs an action affects. One test per acceptance criterion that can be tested.

**Done when:** `npm run test` shows the new tests **red**, each failing because the behaviour is missing, not because of a typo or import error.

## 5. Implement

Make the tests green with the smallest change that delivers the ticket. Match the surrounding code: its comment density (comments explain _why_), naming and idiom. Reuse the existing helpers the notes point to rather than writing parallel ones. UI work composes the primitives in `src/components/ui.jsx` and the semantic tokens listed in CLAUDE.md.

Scope is exactly this ticket. Work that belongs to a later ticket stays out, even when it's adjacent.

**Done when:** the new tests are green, and so is the whole suite.

## 6. Verify

Run the CI gate locally, in order. Each step gates the next:

```bash
npm run lint && npm run format:check && npm run test && npm run build:renderer
```

If `format:check` fails, run `npm run format` and re-run the gate.

If you touched anything under `electron/`, restart `npm run dev` before checking behaviour in the app. The main process does not hot-reload.

Then walk every acceptance criterion in the running app. Where you can't drive the GUI yourself, list the exact manual checks for the human in the PR.

**Done when:** all four gate steps pass, and every acceptance criterion is either verified (with how) or listed as a manual check.

## 7. Open the PR

Commit messages follow the repo's history: `feat(agents): …`, `fix(terminal): …`, `test: …`. Then:

```bash
git push -u origin HEAD
gh pr create --base develop --title "<type>(<area>): <summary>" --body-file <body.md>
```

The PR body contains:

- `Closes #<N>`
- the acceptance criteria as a checklist. Tick only the boxes you verified, and say how next to each one.
- **Deviations:** anywhere the code made you depart from the ticket or notes, and why.
- **Manual checks:** the steps the human should run in the app.

**Done when:** the PR is open against `develop`, and its checklist matches what you actually verified.

## When the ticket is ambiguous

If the ticket, spec and notes leave a decision open that changes behaviour, comment the question on the issue with your recommended answer, then stop and wait for an answer. A reasonable default for something purely internal (a variable name, a helper's location) is yours to pick: note it under **Deviations**.
