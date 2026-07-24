'use strict';

// Read-only git status for the Agents project explorer's "Changes" tab.
// Everything here shells out to `git` with `-C <root>` and only ever reads
// (status/diff) — it never mutates the working tree or the index.

const { execFile } = require('child_process');
const path = require('path');

// Run a git subcommand in `root`, resolving to stdout (or null on any error,
// e.g. git missing, not a repo, timeout). Never rejects.
function run(root, args) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', root, ...args],
      { timeout: 8000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout)
    );
  });
}

// Sum additions/deletions per file from `git diff --numstat` output into `acc`.
function accumulateNumstat(out, acc) {
  (out || '').split('\n').forEach((line) => {
    if (!line.trim()) return;
    const parts = line.split('\t');
    if (parts.length < 3) return;
    const [a, d, p] = parts;
    // Binary files report "-"; count them as 0.
    const additions = a === '-' ? 0 : parseInt(a, 10) || 0;
    const deletions = d === '-' ? 0 : parseInt(d, 10) || 0;
    const cur = acc[p] || { additions: 0, deletions: 0 };
    cur.additions += additions;
    cur.deletions += deletions;
    acc[p] = cur;
  });
}

// Returns { isRepo, branch, files:[{ path, rel, name, status, staged,
// additions, deletions }], additions, deletions } for the working tree at
// `rootPath`. `status` is a single letter: M/A/D/R/C, or ? for untracked.
async function gitStatus(rootPath) {
  const root = path.resolve(rootPath);

  const inside = await run(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside || inside.trim() !== 'true') return { isRepo: false };

  const [branchOut, statusOut, unstaged, staged] = await Promise.all([
    run(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    run(root, ['status', '--porcelain=v1']),
    run(root, ['diff', '--numstat']),
    run(root, ['diff', '--cached', '--numstat']),
  ]);

  const branch = (branchOut || '').trim() || 'HEAD';

  // Combined per-file line counts (staged edits + further unstaged edits).
  const stat = {};
  accumulateNumstat(unstaged, stat);
  accumulateNumstat(staged, stat);

  const files = [];
  let additions = 0;
  let deletions = 0;

  (statusOut || '').split('\n').forEach((line) => {
    if (!line) return;
    const x = line[0];
    const y = line[1];
    let rest = line.slice(3);
    // Renames/copies read "old -> new"; key everything off the new path.
    if (rest.includes(' -> ')) rest = rest.split(' -> ')[1];
    // git quotes paths containing unusual bytes.
    const rel = rest.replace(/^"|"$/g, '');

    const untracked = x === '?';
    // Prefer the staged code, falling back to the worktree code.
    const code = untracked ? '?' : x !== ' ' ? x : y;
    const counts = stat[rel] || { additions: 0, deletions: 0 };
    additions += counts.additions;
    deletions += counts.deletions;

    files.push({
      path: path.join(root, rel),
      rel,
      name: path.basename(rel),
      status: code,
      staged: !untracked && x !== ' ',
      additions: counts.additions,
      deletions: counts.deletions,
    });
  });

  return { isRepo: true, branch, files, additions, deletions };
}

module.exports = { gitStatus };
