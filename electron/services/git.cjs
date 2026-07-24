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

// Returns { isRepo, branch, files, additions, deletions } for the working tree
// at `rootPath`. `files` is one entry per changed source (see parseStatus);
// `additions`/`deletions` are the changeset totals. Non-repos → { isRepo:false }.
async function gitStatus(rootPath) {
  const root = path.resolve(rootPath);

  const inside = await run(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside || inside.trim() !== 'true') return { isRepo: false };

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
    return { ...e, path: path.join(root, e.rel), additions: a, deletions: d };
  });

  return { isRepo: true, branch, files, additions, deletions };
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

module.exports = { gitStatus, parseStatus, parseNumstat, fileAt };
