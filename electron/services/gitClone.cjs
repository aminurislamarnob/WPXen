'use strict';

// Add project → Clone from URL…: `git clone` a remote into a parent folder,
// streaming progress, then the caller adds the result as a folder project.
// Modelled on Orca's clone step — the repo lands at <parent>/<repo-name>, a
// folder the clone created is removed again on failure or cancel, and only one
// clone runs at a time.
//
// The pure helpers (repo name, target path, progress lines, error text) are
// exported for the tests; `clone` is the only part that touches the system.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// The folder name `git clone` would pick: the URL's last path segment, minus a
// trailing `.git`. Handles https, ssh (`git@host:owner/repo.git`) and local
// paths alike, since all three end in /name or :name.
function repoNameFromUrl(url) {
  const trimmed = String(url || '')
    .trim()
    .replace(/[/\\]+$/, '');
  const last = trimmed.split(/[/\\:]/).pop() || '';
  const name = last.replace(/\.git$/i, '');
  // `.` / `..` or an empty segment would resolve outside the parent folder.
  if (!name || name === '.' || name === '..') return null;
  return name;
}

// Validate the request and return the absolute folder the repo clones into.
// Throws with a user-facing message.
function cloneTarget(url, parent) {
  const u = String(url || '').trim();
  if (!u) throw new Error('Enter a Git URL.');
  // `--` already stops git reading it as an option; refuse it outright anyway.
  if (u.startsWith('-')) throw new Error('That doesn’t look like a Git URL.');
  // git's ext:: transport runs an arbitrary command — never from a pasted URL.
  if (/^ext::/i.test(u)) throw new Error('The ext:: transport is not allowed.');
  const p = String(parent || '').trim();
  if (!p || !path.isAbsolute(p)) throw new Error('Choose a parent folder.');
  const name = repoNameFromUrl(u);
  if (!name) throw new Error('Couldn’t work out a folder name from that URL.');
  const target = path.join(path.resolve(p), name);
  const rel = path.relative(path.resolve(p), target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('The clone must land inside the parent folder.');
  }
  return target;
}

// `git clone --progress` writes "Receiving objects:  42% (…)" lines to stderr,
// separated by \r while a phase is updating. Returns the last one in `chunk`.
function parseProgress(chunk) {
  let last = null;
  for (const line of String(chunk).split(/[\r\n]+/)) {
    const m = line.match(/^(?:remote:\s*)?([A-Za-z][\w ]*?):\s+(\d+)%/);
    if (m) last = { phase: m[1].trim(), percent: Math.min(100, Number(m[2])) };
  }
  return last;
}

// The line worth showing from a failed clone's stderr: the last `fatal:` or
// `error:`, else the last non-empty line.
function cloneErrorMessage(stderr) {
  const lines = String(stderr || '')
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const hit = [...lines].reverse().find((l) => /^(fatal|error):/i.test(l));
  const msg = (hit || lines[lines.length - 1] || 'unknown error').replace(
    /^(fatal|error):\s*/i,
    ''
  );
  if (/destination path .* already exists/i.test(msg)) {
    return 'A folder with that name already exists in the parent folder.';
  }
  if (/terminal prompts disabled|could not read Username/i.test(msg)) {
    return 'The repository needs credentials. Use an SSH URL, or sign in with git (e.g. gh auth login) first.';
  }
  if (/Permission denied \(publickey/i.test(msg)) {
    return 'SSH key was rejected. Check that your key is added to the Git host.';
  }
  return msg;
}

let active = null; // { child, aborted }

// Clone `url` into `parent`. `onProgress({ phase, percent })` is called as git
// reports it. Resolves to the repo's absolute path; rejects with a readable
// message. `env` is the user's login-shell env so git, its credential helper
// and SSH agent are the ones their terminal uses.
function clone({ url, parent, env, onProgress }) {
  if (active) return Promise.reject(new Error('Another clone is already running.'));
  const target = cloneTarget(url, parent);
  if (fs.existsSync(target)) {
    return Promise.reject(
      new Error('A folder with that name already exists in the parent folder.')
    );
  }
  fs.mkdirSync(parent, { recursive: true });

  return new Promise((resolve, reject) => {
    const child = spawn(
      'git',
      ['-c', 'protocol.ext.allow=never', 'clone', '--progress', '--', url.trim(), target],
      {
        cwd: parent,
        env: { ...(env || process.env), GIT_TERMINAL_PROMPT: '0' },
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    );
    let markDone;
    const run = { child, aborted: false, done: new Promise((r) => (markDone = r)) };
    active = run;
    let stderr = '';
    child.stderr.on('data', (buf) => {
      const text = buf.toString();
      stderr = (stderr + text).slice(-8192);
      const p = parseProgress(text);
      if (p && onProgress) onProgress(p);
    });
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (active === run) active = null;
      if (!err) {
        markDone();
        return resolve(target);
      }
      // git usually removes its own half-made folder; make sure of it. We
      // checked above that nothing lived at `target` before the clone.
      fs.rm(target, { recursive: true, force: true }, () => {
        markDone();
        reject(err);
      });
    };
    child.on('error', (e) =>
      finish(
        new Error(e.code === 'ENOENT' ? 'git was not found on your PATH.' : e.message)
      )
    );
    child.on('close', (code) => {
      if (run.aborted) return finish(new Error('Clone cancelled.'));
      if (code === 0) return finish(null);
      finish(new Error(cloneErrorMessage(stderr)));
    });
  });
}

function abort() {
  if (!active) return false;
  active.aborted = true;
  active.child.kill('SIGTERM');
  return true;
}

// On app quit: cancel a running clone and resolve once git has exited and its
// partial folder is gone, so the app doesn't exit first and orphan either.
// A git that ignores SIGTERM gets SIGKILL after `graceMs`.
function stopAll({ graceMs = 3000 } = {}) {
  const run = active;
  if (!run) return Promise.resolve();
  run.aborted = true;
  run.child.kill('SIGTERM');
  const timer = setTimeout(() => run.child.kill('SIGKILL'), graceMs);
  return run.done.finally(() => clearTimeout(timer));
}

module.exports = {
  repoNameFromUrl,
  cloneTarget,
  parseProgress,
  cloneErrorMessage,
  clone,
  abort,
  stopAll,
};
