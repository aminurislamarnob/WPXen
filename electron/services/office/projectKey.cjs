'use strict';

// ── Project key ──────────────────────────────────────────────
// One-time faithful port of claude-agent-verse packages/server/src/projectKey.ts.
// The project key is what clusters sessions into pods: the git repo name when
// there is one, else the folder basename. Resolving it through git is what
// makes WPXen-spawned and foreign sessions in the same repo share a pod.
// Electron-free: plain node APIs only.

const { execFile } = require('node:child_process');
const { basename } = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

/**
 * Project key for a working directory: the origin remote's repo name, else the
 * repo root's basename, else the directory's own basename.
 * @param {string} cwd
 * @returns {Promise<string>}
 */
async function getProjectKey(cwd) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['config', '--get', 'remote.origin.url'],
      { cwd }
    );
    const url = stdout.trim();
    if (url) {
      const parts = url.split('/');
      const last = parts[parts.length - 1];
      return last.replace(/\.git$/, '');
    }
  } catch {
    // Not a repo, or no remote — fall through.
  }

  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
    });
    return basename(stdout.trim());
  } catch {
    return basename(cwd);
  }
}

module.exports = { getProjectKey };
