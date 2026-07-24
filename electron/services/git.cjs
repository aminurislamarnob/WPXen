'use strict';

// Read-only git status/diff for the Agents project explorer's "Changes" tab.
// Everything here shells out to `git` with `-C <root>` and only ever reads
// (status/diff/show) — it never mutates the working tree or the index.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024; // 2 MB

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

// git quotes paths containing unusual bytes; strip the surrounding quotes.
function unquote(s) {
  return s.replace(/^"|"$/g, '');
}

// Recover the post-rename path from a numstat path field, which can read
// "old => new" or the brace form "dir/{old => new}/file". Best-effort — the
// caller falls back to zero counts if the resulting key doesn't match.
function renameNewPath(p) {
  if (!p.includes(' => ')) return p;
  const brace = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) return (brace[1] + brace[3] + brace[4]).replace(/\/{2,}/g, '/');
  return p.split(' => ').pop();
}

// Parse a `git diff --numstat` block into { rel -> { additions, deletions } }.
// Binary files report "-" for both counts; treat those as 0.
function parseNumstat(out) {
  const map = {};
  (out || '').split('\n').forEach((line) => {
    if (!line.trim()) return;
    const parts = line.split('\t');
    if (parts.length < 3) return;
    const [a, d] = parts;
    const p = renameNewPath(parts.slice(2).join('\t'));
    map[p] = {
      additions: a === '-' ? 0 : parseInt(a, 10) || 0,
      deletions: d === '-' ? 0 : parseInt(d, 10) || 0,
    };
  });
  return map;
}

// Pure parse of `git status --porcelain=v1` plus the unstaged/staged numstat
// maps into per-source file entries. A partially-staged file (e.g. "MM")
// yields two entries — one Staged, one Unstaged — matching source-control UIs.
// Untracked entries get additions:0 here; gitStatus() enriches them with the
// file's line count. Exported for unit tests (no git spawn required).
//
// Each entry: { rel, name, oldRel, status, source, additions, deletions }
//   status: single porcelain letter (M/A/D/R/C) or '?' for untracked
//   source: 'staged' | 'unstaged'
//   oldRel: pre-rename path for staged R/C, else null
function parseStatus(statusOut, unstagedStat, stagedStat) {
  const files = [];
  (statusOut || '').split('\n').forEach((line) => {
    if (!line || line.length < 3) return;
    const x = line[0]; // index (staged) column
    const y = line[1]; // worktree (unstaged) column
    let rest = line.slice(3);
    let oldRel = null;
    // Renames/copies read "old -> new"; key off new, remember old.
    if (rest.includes(' -> ')) {
      const idx = rest.indexOf(' -> ');
      oldRel = unquote(rest.slice(0, idx));
      rest = rest.slice(idx + 4);
    }
    const rel = unquote(rest);
    const name = rel.slice(rel.lastIndexOf('/') + 1);

    // Untracked → a single Unstaged entry.
    if (x === '?' && y === '?') {
      files.push({
        rel,
        name,
        oldRel: null,
        status: '?',
        source: 'unstaged',
        additions: 0,
        deletions: 0,
      });
      return;
    }

    // Staged change from the index column.
    if (x !== ' ' && x !== '?') {
      const c = stagedStat[rel] || { additions: 0, deletions: 0 };
      files.push({
        rel,
        name,
        oldRel: x === 'R' || x === 'C' ? oldRel : null,
        status: x,
        source: 'staged',
        additions: c.additions,
        deletions: c.deletions,
      });
    }

    // Unstaged change from the worktree column.
    if (y !== ' ' && y !== '?') {
      const c = unstagedStat[rel] || { additions: 0, deletions: 0 };
      files.push({
        rel,
        name,
        oldRel: y === 'R' || y === 'C' ? oldRel : null,
        status: y,
        source: 'unstaged',
        additions: c.additions,
        deletions: c.deletions,
      });
    }
  });
  return files;
}

// Count the lines of an untracked file for its "+N" figure. Size-capped and
// binary-sniffed; returns 0 on anything unreadable or non-text.
function countUntrackedLines(absPath) {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_UNTRACKED_BYTES) {
      return 0;
    }
    const buf = fs.readFileSync(absPath);
    if (buf.subarray(0, 8000).includes(0)) return 0; // binary
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
    if (buf[buf.length - 1] !== 10) n++; // last line without trailing newline
    return n;
  } catch {
    return 0;
  }
}

// Directories never worth descending into while hunting for nested repos.
const SCAN_IGNORE = new Set([
  'node_modules',
  'vendor',
  'bower_components',
  '.svn',
  '.hg',
  '.cache',
  'tmp',
]);
const MAX_SCAN_DEPTH = 4; // deep enough for wp-content/plugins/<name>
const MAX_REPOS = 50; // safety cap for pathological trees

// Depth-first scan for git repos beneath `dir`. A directory containing a `.git`
// (dir or file) is a repo root; we record it and stop descending into it.
// Symlinks are not followed (avoids cycles and escaping the project root).
function scanForRepos(dir, depth, found) {
  if (found.length >= MAX_REPOS) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.name === '.git')) {
    found.push(dir);
    return;
  }
  if (depth >= MAX_SCAN_DEPTH) return;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (SCAN_IGNORE.has(e.name) || e.name.startsWith('.')) continue;
    scanForRepos(path.join(dir, e.name), depth + 1, found);
  }
}

// Discover the git repositories relevant to `projectRoot`. If the project root
// is itself a repo, that's the single repo. Otherwise (a WordPress webroot is
// often not tracked, but individual themes/plugins are) scan subfolders for
// nested repos. We never climb above the project root, so everything stays
// confined to the site directory.
function discoverRepos(projectRoot) {
  const root = path.resolve(projectRoot);
  if (fs.existsSync(path.join(root, '.git'))) return [root];
  const found = [];
  scanForRepos(root, 0, found);
  return found;
}

// Read the changeset for one repository at `repoRoot`. Returns
// { branch, files, additions, deletions }; `files` is one entry per changed
// source (see parseStatus), each carrying its absolute path and repoRoot.
async function statusForRepo(repoRoot) {
  const root = path.resolve(repoRoot);

  const [branchOut, statusOut, unstagedOut, stagedOut] = await Promise.all([
    run(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    run(root, ['status', '--porcelain=v1']),
    run(root, ['diff', '--numstat']),
    run(root, ['diff', '--cached', '--numstat']),
  ]);

  const branch = (branchOut || '').trim() || 'HEAD';
  const entries = parseStatus(
    statusOut,
    parseNumstat(unstagedOut),
    parseNumstat(stagedOut)
  );

  let additions = 0;
  let deletions = 0;
  const files = entries.map((e) => {
    let a = e.additions;
    const d = e.deletions;
    // git doesn't numstat untracked files; count their lines directly.
    if (e.status === '?' && a === 0) a = countUntrackedLines(path.join(root, e.rel));
    additions += a;
    deletions += d;
    return { ...e, path: path.join(root, e.rel), repoRoot: root, additions: a, deletions: d };
  });

  return { branch, files, additions, deletions };
}

// Returns { isRepo, repos } for `projectRoot`. `repos` is one entry per git
// repository found in the project (the root itself, or nested repos when the
// root isn't tracked), each with its own branch/files/totals. `rel` on a file
// is relative to that repo's root; `path` is absolute. Empty repos are kept so
// their branch still shows. `relRoot` locates the repo under the project root.
async function gitStatus(projectRoot) {
  const root = path.resolve(projectRoot);
  const repoRoots = discoverRepos(root);

  const repos = [];
  for (const repoRoot of repoRoots) {
    const s = await statusForRepo(repoRoot);
    const relRoot = repoRoot === root ? '' : path.relative(root, repoRoot).split(path.sep).join('/');
    repos.push({ root: repoRoot, relRoot, name: relRoot || path.basename(repoRoot), ...s });
  }

  return { isRepo: repos.length > 0, repos };
}

// Reject a relative path that would escape the repo (defense in depth on top
// of `git -C root`). Absolute paths and any `..` segment are refused.
function assertRepoRel(rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) {
    throw new Error('Invalid path');
  }
  if (rel.split('/').some((seg) => seg === '..')) {
    throw new Error('Invalid path');
  }
  return rel;
}

// Read a file's contents at a git revision, for the diff viewer.
//   rev 'HEAD'  → committed version (git show HEAD:<rel>)
//   rev 'index' → staged version   (git show :0:<rel>)
// Missing at that rev (added/untracked) → { content: '' }. Binary → { binary }.
async function fileAt(rootPath, rel, rev) {
  const root = path.resolve(rootPath);
  assertRepoRel(rel);
  const spec = rev === 'index' ? `:0:${rel}` : `HEAD:${rel}`;
  const out = await run(root, ['show', spec]);
  if (out == null) return { content: '' }; // absent at this rev
  if (out.includes('\0')) return { binary: true };
  return { content: out };
}

// Run a mutating git subcommand, surfacing failures (unlike read-only `run`,
// which swallows them). Resolves { ok } or { ok:false, error }.
function runMutate(root, args) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', root, ...args],
      { timeout: 8000, maxBuffer: 16 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            error: (stderr || err.message || '').trim() || 'git command failed',
          });
        } else {
          resolve({ ok: true });
        }
      }
    );
  });
}

function relList(rels) {
  return (Array.isArray(rels) ? rels : [rels]).filter(Boolean).map(assertRepoRel);
}

// Stage the given repo-relative paths (git add).
async function stage(rootPath, rels) {
  const list = relList(rels);
  if (list.length === 0) return { ok: true };
  return runMutate(path.resolve(rootPath), ['add', '--', ...list]);
}

// Unstage the given repo-relative paths (git restore --staged).
async function unstage(rootPath, rels) {
  const list = relList(rels);
  if (list.length === 0) return { ok: true };
  return runMutate(path.resolve(rootPath), ['restore', '--staged', '--', ...list]);
}

// Discard a tracked file's unstaged changes (git restore): reverts a
// modification or restores a worktree deletion. Untracked files are handled by
// the caller (moved to Trash), never git clean.
async function discardTracked(rootPath, rel) {
  assertRepoRel(rel);
  return runMutate(path.resolve(rootPath), ['restore', '--', rel]);
}

module.exports = {
  gitStatus,
  discoverRepos,
  parseStatus,
  parseNumstat,
  fileAt,
  stage,
  unstage,
  discardTracked,
};
