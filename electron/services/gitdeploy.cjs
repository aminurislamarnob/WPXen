'use strict';

const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const mysql = require('./mysql.cjs');

const execFileAsync = promisify(execFile);

// Git deploy: push a site's files (optionally + a fresh DB dump) to a remote
// the user controls. Every git call is array-argv spawn/execFile — never a
// shell — and auth rides on the user's existing credential setup (SSH keys /
// credential helper); WPHerd stores no git credentials.

const REMOTE_NAME = 'wpherd';
const GIT_TIMEOUT = 600000;

// wp-config.php is excluded by default: its DB credentials are local-only,
// but the salts/keys are real secrets and don't belong in a remote repo.
const GITIGNORE_MARKER = '# Managed by WPHerd';
const GITIGNORE_CONTENT = `${GITIGNORE_MARKER} — edit freely; WPHerd won't overwrite this file.
# wp-config.php contains authentication salts/keys. Remove this line only if
# you understand what you're publishing.
wp-config.php
node_modules/
.DS_Store
wp-content/cache/
wp-content/upgrade/
`;

// Accepts https://, ssh://, git:// URLs and scp-like git@host:path remotes.
// Rejects whitespace/control characters and anything starting with '-' so a
// stored value can never be misparsed as a git option. Pure — tested.
function isValidRemoteUrl(url) {
  if (typeof url !== 'string' || !url.trim() || /[\s\0]/.test(url)) return false;
  if (url.startsWith('-')) return false;
  if (/^(https|ssh|git):\/\/[^/]+\/.+$/.test(url)) return true;
  if (/^[\w.-]+@[\w.-]+:.+$/.test(url)) return true;
  return false;
}

function isValidBranch(branch) {
  return (
    typeof branch === 'string' &&
    /^[A-Za-z0-9._/-]{1,100}$/.test(branch) &&
    !branch.startsWith('-') &&
    !branch.includes('..')
  );
}

// Counts entries in `git status --porcelain` output. Pure — tested.
function countPorcelainEntries(output) {
  return String(output || '')
    .split('\n')
    .filter((l) => l.trim().length > 0).length;
}

async function isGitInstalled() {
  try {
    await execFileAsync('git', ['--version'], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

function git(args, cwd, { onLine, timeout = GIT_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      // Never fall into an interactive credential prompt from a GUI app —
      // fail fast with git's own message instead.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let out = '';
    let err = '';
    const emitLines = (chunk, sink) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim() && onLine) onLine(line.trimEnd());
      }
      return sink + chunk.toString();
    };
    child.stdout.on('data', (d) => (out = emitLines(d, out)));
    child.stderr.on('data', (d) => (err = emitLines(d, err)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else
        reject(
          new Error(err.trim() || out.trim() || `git ${args[0]} exited with code ${code}`)
        );
    });
  });
}

function isRepo(sitePath) {
  return fs.existsSync(path.join(sitePath, '.git'));
}

// Idempotent setup: init the repo if needed, write the WPHerd .gitignore only
// when the site has none, and point the `wpherd` remote at remoteUrl.
async function configure(site, { remoteUrl, branch }) {
  if (!(await isGitInstalled())) {
    throw new Error('Git is not installed. Install the Xcode Command Line Tools first.');
  }
  if (!isValidRemoteUrl(remoteUrl)) {
    throw new Error('Enter a valid git remote URL (https:// or git@host:path).');
  }
  if (!isValidBranch(branch)) {
    throw new Error('Enter a valid branch name.');
  }
  if (!isRepo(site.path)) {
    await git(['init', '-b', branch], site.path);
  }
  const gitignore = path.join(site.path, '.gitignore');
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(gitignore, GITIGNORE_CONTENT, 'utf8');
  }
  const remotes = await git(['remote'], site.path);
  if (
    remotes
      .split('\n')
      .map((r) => r.trim())
      .includes(REMOTE_NAME)
  ) {
    await git(['remote', 'set-url', REMOTE_NAME, remoteUrl], site.path);
  } else {
    await git(['remote', 'add', REMOTE_NAME, remoteUrl], site.path);
  }
  return true;
}

// Dump (optional) → add → commit → push, streaming every git output line.
async function deploy(site, { message, includeDb, branch }, onProgress) {
  const progress = onProgress || (() => {});
  const onLine = (line) => progress({ step: 'git', message: line });
  if (!isRepo(site.path)) {
    throw new Error('Git deploy is not configured for this site yet.');
  }
  if (!isValidBranch(branch)) {
    throw new Error('Enter a valid branch name.');
  }

  if (includeDb) {
    progress({ step: 'dump', message: 'Dumping database to .wpherd/database.sql...' });
    const dumpDir = path.join(site.path, '.wpherd');
    fs.mkdirSync(dumpDir, { recursive: true });
    await mysql.dumpDatabase(site.dbName, path.join(dumpDir, 'database.sql'));
  }

  progress({ step: 'add', message: 'Staging changes...' });
  await git(['add', '-A'], site.path, { onLine });

  const staged = await git(['status', '--porcelain'], site.path);
  if (countPorcelainEntries(staged) > 0) {
    progress({ step: 'commit', message: 'Committing...' });
    const msg = (message || '').trim() || `WPHerd deploy ${new Date().toISOString()}`;
    await git(
      [
        // A deploy must not depend on the user having git identity configured.
        '-c',
        'user.name=WPHerd',
        '-c',
        'user.email=deploy@wpherd.local',
        'commit',
        '-m',
        msg,
      ],
      site.path,
      { onLine }
    );
  } else {
    progress({
      step: 'commit',
      message: 'Nothing new to commit — pushing current history.',
    });
  }

  progress({ step: 'push', message: `Pushing to ${REMOTE_NAME}/${branch}...` });
  await git(['push', '-u', REMOTE_NAME, `HEAD:${branch}`], site.path, { onLine });

  progress({ step: 'done', message: 'Deploy complete.' });
  return { deployedAt: new Date().toISOString() };
}

// Cheap status for the Deploy card: is git available, is the repo set up,
// and how many files are dirty right now.
async function getStatus(site) {
  const gitInstalled = await isGitInstalled();
  const configured = gitInstalled && isRepo(site.path);
  let dirtyCount = 0;
  if (configured) {
    try {
      dirtyCount = countPorcelainEntries(
        await git(['status', '--porcelain'], site.path, { timeout: 30000 })
      );
    } catch {}
  }
  return { gitInstalled, configured, dirtyCount };
}

module.exports = {
  REMOTE_NAME,
  GITIGNORE_CONTENT,
  isValidRemoteUrl,
  isValidBranch,
  countPorcelainEntries,
  isGitInstalled,
  configure,
  deploy,
  getStatus,
};
