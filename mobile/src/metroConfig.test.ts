import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The real proof is `npm run bundle:check`; this pins the two settings that
// made Metro unable to bundle the app, so the cause reads off a test name.

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(mobileRoot, 'package.json'));

describe('metro config', () => {
  const config = require('./metro.config.js');

  it('watches ../shared on top of the defaults rather than instead of them', () => {
    const { getDefaultConfig } = require('expo/metro-config');
    const defaults: string[] = getDefaultConfig(mobileRoot).watchFolders ?? [];
    expect(config.watchFolders).toContain(resolve(mobileRoot, '..', 'shared'));
    for (const folder of defaults) expect(config.watchFolders).toContain(folder);
  });

  it("resolves the shared protocol's tweetnacl to mobile's own copy", () => {
    // shared/ has no node_modules; without this Metro walks up to the
    // desktop's, which it does not watch, and the bundle fails.
    expect(config.resolver.extraNodeModules?.tweetnacl).toBe(
      join(mobileRoot, 'node_modules', 'tweetnacl')
    );
    expect(config.resolver.sourceExts).toContain('cjs');
  });
});
