import { describe, it, expect, beforeEach } from 'vitest';
import taskStart from '../electron/services/taskStart.cjs';

// Start → from an issue: templates, the git plan per mode and what actually
// runs. git is faked through the module's seam; nothing touches a real repo.

const issue = {
  repo: 'acme/shop',
  number: 123,
  url: 'https://github.com/acme/shop/issues/123',
  title: 'Fix: Café checkout — totals wrong when a coupon is applied twice!',
};

describe('templates', () => {
  it('slugs a title: lowercase ASCII, dashes, about 40 characters on a word', () => {
    expect(taskStart.slugify(issue.title)).toBe('fix-cafe-checkout-totals-wrong-when-a');
    expect(taskStart.slugify('  ¿Qué?  ')).toBe('que');
    expect(taskStart.slugify('a'.repeat(60))).toHaveLength(40);
    expect(taskStart.slugify('🔥🔥')).toBe('');
  });

  it('renders the prompt, leaving unknown names alone', () => {
    expect(taskStart.renderTemplate('Complete {{url}}', issue)).toBe(
      'Complete https://github.com/acme/shop/issues/123'
    );
    expect(
      taskStart.renderTemplate('{{repo}}#{{ number }}: {{title}} {{nope}}', issue)
    ).toBe(`acme/shop#123: ${issue.title} {{nope}}`);
  });

  it('makes a git-safe branch name', () => {
    expect(taskStart.branchName('issue-{{number}}-{{slug}}', issue)).toBe(
      'issue-123-fix-cafe-checkout-totals-wrong-when-a'
    );
    // an empty slug leaves no dangling dash
    expect(
      taskStart.branchName('issue-{{number}}-{{slug}}', { number: 4, title: '🔥' })
    ).toBe('issue-4');
    expect(
      taskStart.branchName('feat/{{number}} {{title}}', { number: 5, title: 'a..b: c~d' })
    ).toBe('feat/5-a.b-c-d');
  });
});

describe('git plan', () => {
  const repoRoot = '/Sites/shop/wp-content/themes/shop';

  it('branch: creates in place, or switches to an existing branch', () => {
    expect(
      taskStart.gitPlan({
        mode: 'branch',
        repoRoot,
        branch: 'issue-1',
        branchExists: false,
      })
    ).toEqual({ steps: [['switch', '-c', 'issue-1']], cwd: repoRoot });
    expect(
      taskStart.gitPlan({
        mode: 'branch',
        repoRoot,
        branch: 'issue-1',
        branchExists: true,
      })
    ).toEqual({ steps: [['switch', 'issue-1']], cwd: repoRoot });
  });

  it('worktree: a sibling folder named after the repo and branch', () => {
    const dir = '/Sites/shop/wp-content/themes/shop-issue-1';
    expect(
      taskStart.gitPlan({
        mode: 'worktree',
        repoRoot,
        branch: 'issue-1',
        branchExists: false,
      })
    ).toEqual({
      steps: [['worktree', 'add', '-b', 'issue-1', dir]],
      cwd: dir,
      worktree: dir,
    });
    expect(
      taskStart.gitPlan({
        mode: 'worktree',
        repoRoot,
        branch: 'issue-1',
        branchExists: true,
      }).steps
    ).toEqual([['worktree', 'add', dir, 'issue-1']]);
    expect(taskStart.worktreeDir(repoRoot, 'feat/x')).toBe(
      '/Sites/shop/wp-content/themes/shop-feat-x'
    );
  });

  it('current: no git at all', () => {
    expect(taskStart.gitPlan({ mode: 'current', repoRoot, branch: 'x' })).toEqual({
      steps: [],
      cwd: repoRoot,
    });
  });
});

describe('inspect and apply, with git faked', () => {
  let calls;
  let branches;
  let dirty;
  let failOn;

  beforeEach(() => {
    calls = [];
    branches = new Set(['main']);
    dirty = '';
    failOn = null;
    taskStart.__setDeps({
      runGit: async (root, args) => {
        calls.push(args);
        if (failOn && args[0] === failOn)
          return { ok: false, error: `fatal: ${failOn} failed` };
        if (args[0] === 'status') return { ok: true, stdout: dirty };
        if (args[1] === '--abbrev-ref') return { ok: true, stdout: 'main\n' };
        if (args[1] === '--verify') {
          const name = args[3].replace('refs/heads/', '');
          return branches.has(name) ? { ok: true, stdout: 'abc\n' } : { ok: false };
        }
        return { ok: true, stdout: '' };
      },
    });
  });

  it('reports a dirty checkout and an existing branch', async () => {
    dirty = ' M style.css\n';
    branches.add('issue-123-x');
    expect(await taskStart.inspect({ repoRoot: '/r', branch: 'issue-123-x' })).toEqual({
      dirty: true,
      currentBranch: 'main',
      branchExists: true,
    });
    dirty = '';
    expect(await taskStart.inspect({ repoRoot: '/r', branch: 'issue-9' })).toEqual({
      dirty: false,
      currentBranch: 'main',
      branchExists: false,
    });
  });

  it('creates the branch, or switches when it has appeared since', async () => {
    expect(
      await taskStart.applyPlan({ mode: 'branch', repoRoot: '/r', branch: 'b1' })
    ).toEqual({
      ok: true,
      cwd: '/r',
      worktree: null,
      branchExists: false,
    });
    expect(calls.at(-1)).toEqual(['switch', '-c', 'b1']);
    branches.add('b2');
    await taskStart.applyPlan({ mode: 'branch', repoRoot: '/r', branch: 'b2' });
    expect(calls.at(-1)).toEqual(['switch', 'b2']);
  });

  it('runs no git for the current branch', async () => {
    await taskStart.applyPlan({ mode: 'current', repoRoot: '/r', branch: '' });
    expect(calls).toEqual([]);
  });

  it("refuses a bad branch name or mode, and passes git's error through", async () => {
    expect(
      (await taskStart.applyPlan({ mode: 'branch', repoRoot: '/r', branch: '-x' })).error
    ).toMatch(/valid branch/);
    expect(
      (await taskStart.applyPlan({ mode: 'nope', repoRoot: '/r', branch: 'b' })).error
    ).toMatch(/Unknown mode/);
    failOn = 'worktree';
    expect(
      (await taskStart.applyPlan({ mode: 'worktree', repoRoot: '/r', branch: 'b' })).error
    ).toBe('fatal: worktree failed');
  });
});
