'use strict';

// Start → for Tasks: turn an issue into an agent Session working on it.
//
//   1. Templates — the prompt and branch name are rendered from the issue
//      ({{url}} {{number}} {{title}} {{repo}} {{slug}}).
//   2. Inspect — is the checkout dirty, and does the branch already exist?
//      The dialog warns about the first and offers a switch for the second.
//   3. Git plan — by mode: `branch` switches (or creates) the branch in the
//      repo's own checkout, so the .test site serves the work live;
//      `worktree` adds a sibling worktree; `current` leaves git alone.
//   4. Launch — through agents.launch, at the repo root or the worktree,
//      with the prompt and the issue link on the Session.
//
// git and the launch are reached through `deps` (vi.mock can't reach .cjs),
// and Electron is never required.

const { execFile } = require('child_process');
const path = require('path');

const MODES = ['branch', 'worktree', 'current'];
const SLUG_MAX = 40;

// git's reason, without the progress chatter before it ("Preparing
// worktree…"): the `fatal:` / `error:` line when there is one.
function gitError(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.find((l) => /^(fatal|error):/.test(l)) || lines.pop() || 'git failed';
}

function defaultRunGit(root, args) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', root, ...args],
      { timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) =>
        resolve(
          err
            ? {
                ok: false,
                code: typeof err.code === 'number' ? err.code : null,
                error: gitError(stderr || err.message),
              }
            : { ok: true, stdout: String(stdout || '') }
        )
    );
  });
}

const deps = {
  runGit: defaultRunGit,
};

function __setDeps(next) {
  Object.assign(deps, next);
}

// ── Templates ────────────────────────────────────────────────────────────────

// Lowercase ASCII, runs of anything else collapsed to `-`, trimmed to about
// SLUG_MAX characters on a word boundary where one is close.
function slugify(title) {
  const ascii = String(title || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii.length <= SLUG_MAX) return ascii;
  const cut = ascii.slice(0, SLUG_MAX);
  const dash = cut.lastIndexOf('-');
  return (dash >= SLUG_MAX / 2 ? cut.slice(0, dash) : cut).replace(/-+$/, '');
}

function templateValues(issue) {
  return {
    url: String(issue?.url || ''),
    number: String(issue?.number ?? ''),
    title: String(issue?.title || ''),
    repo: String(issue?.repo || ''),
    slug: slugify(issue?.title),
  };
}

// {{name}} → value; unknown names are left as written.
function renderTemplate(template, issue) {
  const values = templateValues(issue);
  return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : m
  );
}

// A branch name from the template, made safe for git: no spaces, no `..`,
// no leading `-` or `/`, none of git's forbidden characters. An empty slug
// leaves no dangling `-`.
function branchName(template, issue) {
  return renderTemplate(template, issue)
    .replace(/[\s~^:?*[\]\\@{}]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/\/{2,}/g, '/')
    .replace(/-{2,}/g, '-')
    .replace(/^[-/.]+|[-/.]+$/g, '')
    .replace(/\.lock$/, '');
}

const BRANCH_OK = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}(?<![./])$/;

// ── Inspect ──────────────────────────────────────────────────────────────────

async function inspect({ repoRoot, branch }) {
  const [status, current, exists] = await Promise.all([
    deps.runGit(repoRoot, ['status', '--porcelain']),
    deps.runGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    BRANCH_OK.test(String(branch || ''))
      ? deps.runGit(repoRoot, [
          'rev-parse',
          '--verify',
          '--quiet',
          `refs/heads/${branch}`,
        ])
      : Promise.resolve({ ok: false }),
  ]);
  if (!status.ok) return { error: status.error || 'Not a git repository' };
  return {
    dirty: status.stdout.trim().length > 0,
    currentBranch: current.ok ? current.stdout.trim() : null,
    branchExists: !!exists.ok,
  };
}

// ── Git plan ─────────────────────────────────────────────────────────────────

// Where a worktree for `branch` goes: beside the repo, named after both, so
// it's obvious what it is from Finder and never nests inside the webroot.
function worktreeDir(repoRoot, branch) {
  const base = path.basename(repoRoot);
  return path.join(path.dirname(repoRoot), `${base}-${branch.replace(/\//g, '-')}`);
}

// The git commands for a mode, and where the agent then runs.
// → { steps: [args…], cwd, worktree? }
function gitPlan({ mode, repoRoot, branch, branchExists }) {
  if (mode === 'current') return { steps: [], cwd: repoRoot };
  if (mode === 'worktree') {
    const dir = worktreeDir(repoRoot, branch);
    return {
      steps: [
        branchExists
          ? ['worktree', 'add', dir, branch]
          : ['worktree', 'add', '-b', branch, dir],
      ],
      cwd: dir,
      worktree: dir,
    };
  }
  return {
    steps: [branchExists ? ['switch', branch] : ['switch', '-c', branch]],
    cwd: repoRoot,
  };
}

// Runs the plan. → { ok, cwd, worktree? } or { error }.
async function applyPlan({ mode, repoRoot, branch }) {
  if (!MODES.includes(mode)) return { error: `Unknown mode: ${mode}` };
  if (mode !== 'current' && !BRANCH_OK.test(String(branch || ''))) {
    return { error: 'That isn’t a valid branch name.' };
  }
  // Existence is re-checked here rather than trusted from the dialog: the
  // branch may have appeared since it opened.
  let branchExists = false;
  if (mode !== 'current') {
    const res = await deps.runGit(repoRoot, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ]);
    branchExists = !!res.ok;
  }
  const plan = gitPlan({ mode, repoRoot, branch, branchExists });
  for (const args of plan.steps) {
    const res = await deps.runGit(repoRoot, args);
    if (!res.ok) return { error: res.error };
  }
  return { ok: true, cwd: plan.cwd, worktree: plan.worktree || null, branchExists };
}

module.exports = {
  MODES,
  slugify,
  renderTemplate,
  branchName,
  inspect,
  worktreeDir,
  gitPlan,
  applyPlan,
  __setDeps,
};
