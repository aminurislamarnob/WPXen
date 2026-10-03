import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Ratchet: no new module-scope `require('electron')` in the main-process tree.
 *
 * A test that imports a main-process module pulls its whole require graph in
 * under plain Node, where `electron` is not an app runtime — a top-level
 * require there either throws or (since Electron 42 dropped the postinstall
 * download that `ELECTRON_SKIP_BINARY_DOWNLOAD` used to disable) triggers a
 * ~100MB binary download. Modules that need electron resolve it lazily inside
 * the function that uses it; see `browser.cjs`, `safeUrl.cjs`, `siteops.cjs`,
 * `blueprints.cjs`, `procman.cjs`.
 *
 * Two rules, and only two:
 *
 *  1. A file exceeding its allowed count fails. Fix it by resolving the
 *     require lazily inside the function that uses it — never by raising the
 *     number here.
 *  2. A file dropping below its allowed count also fails. Lower the entry (or
 *     delete it) in the same change, so the ratchet only ever tightens.
 *
 * The allowlisted files are the entry points no test imports: they are loaded
 * only by a real Electron main process.
 */
const allowedCounts = {
  'main.cjs': 1,
  'preload.cjs': 1,
  'tray.cjs': 1,
  'store.cjs': 1,
  'ipc.cjs': 1,
};

const electronDir = join(fileURLToPath(new URL('..', import.meta.url)), 'electron');

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.cjs') ? [full] : [];
  });
}

/**
 * Lines that require electron at module scope: they match the require, start
 * at column 0 (an indented one sits inside a function — that's the lazy seam
 * we want), and are not comments. The comment exclusion is load-bearing: the
 * block comment in `browser.cjs` explaining the seam quotes the require at
 * column 0 and would otherwise fail a file doing everything right.
 */
function moduleScopeRequires(source) {
  return source.split('\n').filter((line) => {
    if (!/require\(['"]electron['"]\)/.test(line)) return false;
    if (/^\s/.test(line)) return false;
    const trimmed = line.trim();
    return !trimmed.startsWith('//') && !trimmed.startsWith('*');
  });
}

describe('no module-scope require("electron")', () => {
  const files = walk(electronDir);

  it('finds the main-process tree', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    const name = relative(electronDir, file);
    const allowed = allowedCounts[name] ?? 0;

    it(`${name} has ${allowed} module-scope require("electron")`, () => {
      const hits = moduleScopeRequires(readFileSync(file, 'utf8'));

      if (hits.length > allowed) {
        throw new Error(
          `${name} requires electron at module scope ${hits.length} time(s), allowed ${allowed}:\n` +
            hits.map((line) => `  ${line.trim()}`).join('\n') +
            `\n\nResolve the require lazily inside the function that uses it — a test that ` +
            `imports this module (directly or transitively) loads it outside Electron, where ` +
            `a top-level require downloads or throws. See browser.cjs / safeUrl.cjs.`
        );
      }

      if (hits.length < allowed) {
        throw new Error(
          `${name} now has ${hits.length} module-scope require("electron") but the ratchet ` +
            `allows ${allowed}. Lower (or delete) its entry in allowedCounts so the ratchet ` +
            `only ever tightens.`
        );
      }
    });
  }

  it('allowlist has no entries for files that no longer exist', () => {
    const names = new Set(files.map((file) => relative(electronDir, file)));
    for (const name of Object.keys(allowedCounts)) {
      expect(names, `${name} is allowlisted but missing`).toContain(name);
    }
  });
});
