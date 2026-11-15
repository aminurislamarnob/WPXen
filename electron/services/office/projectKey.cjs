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

/** How long a resolved key is reused before git is asked again. */
const CACHE_TTL_MS = 5 * 60_000;
/** Distinct working directories remembered at once (oldest dropped first). */
const CACHE_MAX = 200;
/** cwd → in-flight or settled lookup. @type {Map<string, { at: number, key: Promise<string> }>} */
const cache = new Map();

/**
 * Project key for a working directory: the origin remote's repo name, else the
 * repo root's basename, else the directory's own basename.
 *
 * Each lookup spawns up to two git processes, and every new session (plus
 * every Antigravity workspace inference) asks, mostly for the same few
 * folders — so keys are cached per cwd for CACHE_TTL_MS, and concurrent asks
 * for one cwd share a single lookup.
 * @param {string} cwd
 * @returns {Promise<string>}
 */
function getProjectKey(cwd) {
  const now = Date.now();
  const hit = cache.get(cwd);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.key;
  cache.delete(cwd);
  const key = resolveProjectKey(cwd);
  cache.set(cwd, { at: now, key });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return key;
}

/**
 * @param {string} cwd
 * @returns {Promise<string>}
 */
async function resolveProjectKey(cwd) {
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
