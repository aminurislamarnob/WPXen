You are implementing GitHub issues #110 through #123 in the WPXen repo (aminurislamarnob/WPXen), one after another, in numeric order, without waiting for me between tickets. They are the tickets of spec #109 (Chat view).

## Read first, once

1. AGENTS.md, then all of CLAUDE.md and CONTEXT.md. CLAUDE.md is the source of truth for commands, the CI gate, the process split, test seams and UI tokens.
2. docs/agents/implementing-a-ticket.md is the per-ticket workflow. Follow it, with the two changes under "Stacking" below.
3. Spec #109: `gh issue view 109 --comments`.

## For each ticket N, in order 110, 111, …, 123

1. `gh issue view N --comments`. The "Implementation notes" comment overrides the spec where they disagree. The code overrides the notes when something has moved, so re-find it rather than trusting a line number.
2. Branch (see Stacking).
3. Map the code, then write failing tests first, at the seam the notes name. Use real-shaped transcript fixtures (redacted) where the notes ask for them. Use `__setDeps` for main-process modules: `vi.mock` doesn't reach `electron/**/*.cjs`. There is no DOM in tests, so extract pure modules into `src/lib/`.
4. Implement exactly this ticket's scope. Work that belongs to a later ticket waits for that ticket.
5. Run the gate. It must be fully green before you commit:
   `npm run lint && npm run format:check && npm run test && npm run build:renderer`
   If format:check fails, run `npm run format` and re-run the whole gate.
6. Commit, push, open the PR (see "PR" below).
7. Move to the next ticket immediately.

## Stacking (overrides steps 1–2 of the workflow doc)

- #110 branches from the latest `origin/develop`. Each later ticket N branches from ticket N−1's branch: `git switch -c feat/N-<slug> feat/<N-1>-<slug>`.
- A blocker counts as satisfied when it is closed, or when it is a ticket you already opened a PR for in this run.
- PR base: #110 targets `develop`. Every later PR targets the previous ticket's branch, so each PR shows only its own diff.
- If you have to fix an earlier ticket after later branches exist: commit the fix on that ticket's branch. Then rebase each later branch onto its parent, in order (`git rebase --onto <new parent> <old parent> <branch>`). Re-run the gate on every rebased branch and push with `--force-with-lease`.

## PR

- Write the body to a file OUTSIDE the repo (e.g. `/tmp/pr-N.md`), never inside the working tree. Then:
  `gh pr create --base <base> --title "feat(agents): <summary> (#N)" --body-file /tmp/pr-N.md`
- The body contains:
  - `Closes #N`
  - the acceptance criteria as a checklist. Tick only what you verified, and say how next to each one.
  - **Deviations**: where you departed from the ticket or notes, and why.
  - **Decisions pending**: see "Ambiguity" below.
  - **Manual checks**: exact steps for me in the running app.

## Hard rules (each one broke a previous run)

- Before every commit, run `git status` and stage only files you meant to change. No PR bodies, scratch files, logs or fixtures outside `test/`.
- The renderer bridge is `window.electronAPI`. Never use `window.api`.
- Import only packages listed in `package.json` dependencies. A transitive dependency that happens to resolve doesn't count.
- Comments explain _why_, briefly, in the style of the surrounding code. Never leave notes-to-self or deliberation ("wait…", "actually…", "I'll just…") in code or comments.
- Add tests; never rewrite or delete existing tests to make room. If an existing test is genuinely wrong, say so under Deviations.
- Never `require('electron')` at module scope in anything a test imports. The ratchet test must stay green.
- UI uses the primitives in `src/components/ui.jsx` and the semantic tokens in CLAUDE.md. No literal colours, no `dark:` variants, no backdrop-filter or blur, no `mr-*` on button icons.
- Never merge a PR, push to `develop`, or force-push a branch you didn't create in this run.
- Never claim something passed unless you ran it and saw it pass. "Done" means the gate is green on that branch and the PR is open.

## Ambiguity

If the ticket, notes and code leave open a decision that changes user-visible behaviour:

- comment the question on the issue, with your recommended answer;
- implement the recommended answer;
- list it under "Decisions pending" in the PR;
- carry on.
  Pick internal details (names, helper locations) yourself and note them under Deviations.

## Stop and report instead of continuing if

- you can't get the gate green on a ticket after a real attempt (report the failing step and its output), or
- a ticket's notes conflict with already-merged code in a way you can't resolve without a product decision.
  Leave that ticket's branch pushed with its work so far, and don't start tickets that depend on it.

## Resuming

If you lose context mid-run, run `gh pr list --state open --search "head:feat/11 OR head:feat/12"` and check which branches exist on origin. Continue from the first ticket without an open PR.

## When all fourteen are done (or you stopped), report

A table with one row per ticket: number, branch, PR link, gate result, acceptance criteria verified vs listed as manual, deviations, and decisions pending. Then the merge order.
