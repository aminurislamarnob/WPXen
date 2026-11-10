#!/usr/bin/env node

// Bundles the app the way a build does (`expo export`, iOS) into a throwaway
// directory and fails when Metro can't. Typecheck and vitest both resolve
// modules through Node, so neither notices a module Metro cannot reach —
// that is how a bundle-breaking `tweetnacl` import from ../shared once got
// through every other check.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = mkdtempSync(join(tmpdir(), 'wpxen-mobile-bundle-'));
let status = 1;
try {
  const result = spawnSync(
    'npx',
    ['expo', 'export', '--platform', 'ios', '--output-dir', out],
    { cwd: root, stdio: 'inherit', env: { ...process.env, CI: '1' } }
  );
  status = result.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
process.exit(status);
