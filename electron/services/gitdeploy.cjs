'use strict';

// Git-based deploy for a site: init a repo in the site directory, point it at
// a remote, and commit + push on demand. Authentication rides entirely on the
// user's existing setup (ssh keys / git credential helper) — WPHerd stores no
// credentials, only { remoteUrl, branch, includeUploads, includeDbDump } on
// the site record.

const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const brew = require('./brew.cjs');
const mysql = require('./mysql.cjs');

const execFileAsync = promisify(execFile);

const DB_DUMP_FILE = 'wpherd-db.sql';

function getGitBin() {
  const prefix = brew.getBrewPrefix();
  const candidates = [prefix ? `${prefix}/bin/git` : null, '/usr/bin/git'].filter(
    Boolean
  );
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function requireGit() {
  const bin = getGitBin();
  if (!bin) {
    throw new Error('git is not installed. Install the Xcode Command Line Tools.');
  }
  return bin;
}

// ─── Pure helpers (exported for tests) ─────────────────────────────────────

// Default .gitignore for a WordPress site repo. wp-config.php is always
// excluded — it carries DB credentials and salts and must never be pushed.
function buildGitignore({ includeUploads = false } = {}) {
  const lines = [
    '# WPHerd defaults',
    'wp-config.php',
    '.DS_Store',
    '*.log',
    'node_modules/',
    'wp-content/cache/',
    'wp-content/upgrade/',
  ];
  if (!includeUploads) lines.push('wp-content/uploads/');
  return lines.join('\n') + '\n';
}

// Remote URLs we're willing to hand to git: ssh scp-like (git@host:path),
// ssh://, or https://. A leading '-' would be parsed as a git option.
function validateRemoteUrl(url) {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.startsWith('-')) return false;
  return (
    /^https:\/\/[^/]+\/.+$/.test(trimmed) ||
    /^ssh:\/\/[^/]+\/.+$/.test(trimmed) ||
    /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:.+$/.test(trimmed)
  );
}

// Environment for network git operations: never hang on a hidden credential
// prompt (fail fast with a readable error instead), and accept unknown host
// keys on first contact while still failing hard if a known key changes.
// BatchMode means passphrase-protected keys must be loaded in ssh-agent.
function buildDeployEnv(base = process.env) {
  return {
    ...base,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
  };
}

// ─── Repo state ─────────────────────────────────────────────────────────────

async function git(sitePath, args, opts = {}) {
  const bin = requireGit();
  return execFileAsync(bin, ['-C', sitePath, ...args], {
    timeout: opts.timeout || 30000,
    maxBuffer: 8 * 1024 * 1024,
    env: opts.env || process.env,
  });
}

async function isRepo(sitePath) {
  try {
    const { stdout } = await git(sitePath, ['rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

// Initializes a repo in the site directory (adopting an existing one) and
// writes the default .gitignore only when none exists — never clobbers a
// user's own ignore rules.
async function initRepo(sitePath, { includeUploads = false } = {}) {
  if (!(await isRepo(sitePath))) {
    await git(sitePath, ['init', '-b', 'main']);
  }
  const ignoreFile = path.join(sitePath, '.gitignore');
  if (!fs.existsSync(ignoreFile)) {
    fs.writeFileSync(ignoreFile, buildGitignore({ includeUploads }));
  }
}

// Updates only the uploads rule in a WPHerd-written .gitignore when the
// includeUploads toggle changes; a hand-edited file is left alone unless the
// rule itself is present/absent as expected.
function setUploadsIgnored(sitePath, ignored) {
  const ignoreFile = path.join(sitePath, '.gitignore');
  if (!fs.existsSync(ignoreFile)) return;
  let lines = fs.readFileSync(ignoreFile, 'utf8').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const has = lines.includes('wp-content/uploads/');
  if (ignored && !has) lines.push('wp-content/uploads/');
  else if (!ignored && has) lines = lines.filter((l) => l !== 'wp-content/uploads/');
  else return;
  fs.writeFileSync(ignoreFile, lines.join('\n') + '\n');
}

async function getStatus(sitePath) {
  if (!(await isRepo(sitePath))) return { isRepo: false };

  const status = { isRepo: true, branch: null, remoteUrl: null, dirtyCount: 0, lastCommit: null };
  try {
    const { stdout } = await git(sitePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    status.branch = stdout.trim(); // 'HEAD' when detached
  } catch {
    // Fresh repo with no commits — rev-parse fails; the branch comes from
    // symbolic-ref instead.
    try {
      const { stdout } = await git(sitePath, ['symbolic-ref', '--short', 'HEAD']);
      status.branch = stdout.trim();
    } catch {}
  }
  try {
    const { stdout } = await git(sitePath, ['remote', 'get-url', 'origin']);
    status.remoteUrl = stdout.trim() || null;
  } catch {}
  try {
    const { stdout } = await git(sitePath, ['status', '--porcelain']);
    status.dirtyCount = stdout.split('\n').filter((l) => l.trim()).length;
  } catch {}
  try {
    const { stdout } = await git(sitePath, ['log', '-1', '--format=%H%x09%s%x09%cI']);
    const [hash, subject, date] = stdout.trim().split('\t');
    if (hash) status.lastCommit = { hash, subject, date };
  } catch {}
  return status;
}

async function setRemote(sitePath, url) {
  if (!validateRemoteUrl(url)) {
    throw new Error('Enter an ssh (git@host:path) or https remote URL.');
  }
  const trimmed = url.trim();
  try {
    await git(sitePath, ['remote', 'set-url', 'origin', trimmed]);
  } catch {
    await git(sitePath, ['remote', 'add', 'origin', trimmed]);
  }
}

// ─── Deploy ─────────────────────────────────────────────────────────────────

// Runs one git step, streaming trimmed output lines to onLine.
function gitStream(sitePath, args, onLine, { env, timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const bin = requireGit();
    const child = spawn(bin, ['-C', sitePath, ...args], { env: env || process.env });
    let tail = '';
    const emit = (buf) => {
      const text = buf.toString();
      tail = (tail + text).slice(-4000);
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) onLine(trimmed);
      }
    };
    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ code, tail });
      else reject(Object.assign(new Error(tail.trim() || `git exited (code ${code}).`), { code, tail }));
    });
  });
}

// Commit + push. Streams every git output line to `onLine`. Steps:
//   1. optional plain-SQL DB dump into the repo (diffs sanely in git)
//   2. git add -A
//   3. commit (per-invocation identity fallback when user.email is unset)
//   4. push origin HEAD:<branch>
async function deploy(site, message, onLine = () => {}) {
  const sitePath = site.path;
  if (!(await isRepo(sitePath))) {
    throw new Error('This site is not a git repository yet. Initialize it first.');
  }
  const settings = site.gitDeploy || {};
  const env = buildDeployEnv();

  if (settings.includeDbDump) {
    onLine(`Dumping database to ${DB_DUMP_FILE}…`);
    await dumpPlainSql(site.dbName, path.join(sitePath, DB_DUMP_FILE));
  }

  onLine('Staging changes…');
  await gitStream(sitePath, ['add', '-A'], onLine);

  // Committing needs an identity; fall back per-invocation rather than ever
  // touching the user's global config.
  let identityArgs = [];
  try {
    const { stdout } = await git(sitePath, ['config', 'user.email']);
    if (!stdout.trim()) throw new Error('unset');
  } catch {
    identityArgs = [
      '-c',
      'user.name=WPHerd',
      '-c',
      `user.email=${site.adminEmail || 'wpherd@localhost'}`,
    ];
  }

  onLine('Committing…');
  const commitMessage = (message || '').trim() || `WPHerd deploy ${new Date().toISOString()}`;
  try {
    await gitStream(sitePath, [...identityArgs, 'commit', '-m', commitMessage], onLine);
  } catch (err) {
    // "nothing to commit" is fine — push whatever is already committed.
    if (!/nothing to commit|nothing added to commit/i.test(err.tail || err.message)) {
      throw err;
    }
    onLine('Nothing new to commit.');
  }

  const status = await getStatus(sitePath);
  if (!status.remoteUrl) {
    throw new Error('No remote configured. Set a remote URL to push.');
  }

  const branch = settings.branch || 'main';
  onLine(`Pushing to ${status.remoteUrl} (${branch})…`);
  try {
    await gitStream(sitePath, ['push', '-u', 'origin', `HEAD:${branch}`], onLine, {
      env,
    });
  } catch (err) {
    const text = err.tail || err.message || '';
    if (/permission denied \(publickey\)/i.test(text)) {
      throw new Error(
        'SSH authentication failed. Load your key into ssh-agent (ssh-add) or check your deploy key.'
      );
    }
    if (/terminal prompts disabled|could not read Username/i.test(text)) {
      throw new Error(
        'No stored credentials for this https remote. Use an ssh remote or configure a git credential helper.'
      );
    }
    throw err;
  }

  onLine('Deploy complete.');
  return getStatus(sitePath);
}

// Plain (uncompressed) dump for in-repo versioning.
function dumpPlainSql(dbName, destPath) {
  if (typeof dbName !== 'string' || !/^[a-zA-Z0-9_]{1,64}$/.test(dbName)) {
    throw new Error(`Unsafe database name: ${dbName}`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(mysql.getMysqldumpBin(), mysql.buildDumpArgs(dbName, mysql.getCredentials()), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = fs.createWriteStream(destPath, { mode: 0o600 });
    let stderrTail = '';
    let exitCode = null;
    let finished = false;
    let settled = false;
    const trySettle = () => {
      if (settled || exitCode === null || !finished) return;
      settled = true;
      if (exitCode === 0) resolve();
      else {
        try {
          fs.unlinkSync(destPath);
        } catch {}
        reject(new Error(stderrTail.trim() || `mysqldump exited (code ${exitCode}).`));
      }
    };
    child.stderr.on('data', (b) => {
      stderrTail = (stderrTail + b.toString()).slice(-4000);
    });
    child.stdout.pipe(out);
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on('close', (code) => {
      exitCode = code;
      trySettle();
    });
    out.on('finish', () => {
      finished = true;
      trySettle();
    });
    out.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

module.exports = {
  getGitBin,
  isRepo,
  initRepo,
  getStatus,
  setRemote,
  setUploadsIgnored,
  deploy,
  // Exported for tests
  buildGitignore,
  validateRemoteUrl,
  buildDeployEnv,
};
