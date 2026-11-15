import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENVIRONMENT_IDS } from '../src/lib/office/scene/environments.js';
import {
  ENVIRONMENT_COMPONENTS,
  ENVIRONMENT_LOADERS,
} from '../src/components/office/scene/environments/index.js';

// Only the chosen environment runs: each world is its own chunk, loaded on
// first use. One static import of a world (or of a world's own helper module)
// anywhere in the renderer would put it back in the Office bundle, where it
// is parsed and its module-scope geometry built whichever world is chosen.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORLDS = ['City', 'Space', 'Island', 'Underwater', 'Cyberpunk', 'Green'];
// city.js is not one world's: the room and the shared kit use it too.
const HELPERS = ['space', 'island', 'underwater', 'cyberpunk', 'green'];
const ENV_DIR = 'src/components/office/scene/environments';

function sources(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(js|jsx)$/.test(entry.name) ? [path.split(sep).join('/')] : [];
  });
}

/** Every `import … from '<spec>'` and side-effect `import '<spec>'`, not `import()`. */
const staticImports = (text) =>
  [...text.matchAll(/^\s*import\s+(?:[^'"()]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map(
    (m) => m[1]
  );

describe('office environment loading', () => {
  it('has a loader and a lazy component for every environment', () => {
    expect(Object.keys(ENVIRONMENT_LOADERS)).toEqual(ENVIRONMENT_IDS);
    expect(Object.keys(ENVIRONMENT_COMPONENTS)).toEqual(ENVIRONMENT_IDS);
    for (const id of ENVIRONMENT_IDS)
      expect(ENVIRONMENT_COMPONENTS[id].$$typeof, id).toBe(Symbol.for('react.lazy'));
  });

  it('never imports a world, or its helpers, statically', () => {
    const offenders = [];
    for (const file of [...sources('src'), ...sources('dev')]) {
      const own = WORLDS.find((w) => file === `${ENV_DIR}/${w}.jsx`);
      for (const spec of staticImports(readFileSync(join(ROOT, file), 'utf8'))) {
        const world = WORLDS.find((w) =>
          new RegExp(`environments/${w}(\\.jsx)?$`).test(spec)
        );
        const helper = HELPERS.find((h) => new RegExp(`scene/${h}(\\.js)?$`).test(spec));
        // A world may import its own helper module, nothing else of another world.
        const allowed = helper && own && own.toLowerCase() === helper;
        if ((world || helper) && !allowed) offenders.push(`${file} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('loads each world through a dynamic import in the registry', () => {
    const registry = readFileSync(join(ROOT, ENV_DIR, 'index.js'), 'utf8');
    for (const w of WORLDS) expect(registry).toContain(`import('./${w}.jsx')`);
  });

  it('shows every environment in the Settings picker with a still of it', () => {
    const picker = readFileSync(
      join(ROOT, 'src/components/settings/sections/OfficeSection.jsx'),
      'utf8'
    );
    for (const id of ENVIRONMENT_IDS) {
      const shot = `src/assets/office-environments/${id}.webp`;
      expect(existsSync(join(ROOT, shot)), shot).toBe(true);
      expect(picker, id).toContain(`office-environments/${id}.webp'`);
    }
  });
});
