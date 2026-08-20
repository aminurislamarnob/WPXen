import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import agents from '../electron/services/agents.cjs';

// resolveBin walks a real PATH and stats real files, so this builds real
// fixture directories rather than mocking fs — the bug being guarded against
// (an executable wrapper script shadowing the CLI it is named after) is a
// filesystem fact, and a mocked stat would let it back in unnoticed.
let root;
let realDir; // stands in for /opt/homebrew/bin
let shimDir; // stands in for ~/.superset/bin

const bin = (dir, name, body, mode = 0o755) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  fs.chmodSync(p, mode);
  return p;
};

// Trimmed from the real thing: shebang, marker comment, PATH search that skips
// its own directory, exec or error.
const supersetShim = (name) => `#!/bin/bash
# Superset agent-wrapper v3
# Superset wrapper for ${name}
REAL_BIN="$(find_real_binary "${name}")"
if [ -z "$REAL_BIN" ]; then
  echo "Superset: ${name} not found in PATH. Install it and ensure it is on PATH, then retry." >&2
  exit 127
fi
exec "$REAL_BIN" "$@"
`;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-resolvebin-'));
  realDir = path.join(root, 'real');
  shimDir = path.join(root, 'shim');
  fs.mkdirSync(realDir);
  fs.mkdirSync(shimDir);
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const withPath = (...dirs) => ({ PATH: dirs.join(':') });

describe('isWrapperShim', () => {
  it('recognises a Superset agent wrapper', () => {
    const p = bin(shimDir, 'wrapped', supersetShim('wrapped'));
    expect(agents.isWrapperShim(p)).toBe(true);
  });

  // The marker has to be near the top; a CLI that merely mentions the word
  // somewhere in a long script is not a wrapper.
  it('does not flag a script that only mentions the word much later', () => {
    const p = bin(
      shimDir,
      'mentions-late',
      `#!/bin/sh\n${'# padding\n'.repeat(200)}# superset agent-wrapper\n`
    );
    expect(agents.isWrapperShim(p)).toBe(false);
  });

  // npm globals and many real CLIs are shebang scripts. Being a script is not
  // the signal — carrying the marker is.
  it('does not flag an ordinary shebang script', () => {
    const p = bin(realDir, 'node-cli', '#!/usr/bin/env node\nrequire("./cli.js");\n');
    expect(agents.isWrapperShim(p)).toBe(false);
  });

  it('does not flag a compiled binary', () => {
    const p = bin(realDir, 'compiled', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00]));
    expect(agents.isWrapperShim(p)).toBe(false);
  });

  it('reports false for a path that does not exist', () => {
    expect(agents.isWrapperShim(path.join(root, 'nope'))).toBe(false);
  });
});

describe('resolveBin', () => {
  it('finds an executable on PATH', () => {
    const p = bin(realDir, 'findable', '#!/bin/sh\nexit 0\n');
    expect(agents.resolveBin('findable', withPath(realDir))).toBe(p);
  });

  it('returns null when nothing on PATH matches', () => {
    expect(agents.resolveBin('absent', withPath(realDir, shimDir))).toBeNull();
  });

  it('ignores a non-executable file of the right name', () => {
    bin(realDir, 'noexec', '#!/bin/sh\n', 0o644);
    expect(agents.resolveBin('noexec', withPath(realDir))).toBeNull();
  });

  // The regression this whole guard exists for: Superset plants shims named
  // after agent CLIs, and one shadowing an uninstalled agent used to make it
  // report as detected — which also hid its working Install button.
  it('does not resolve a wrapper shim when the real binary is absent', () => {
    bin(shimDir, 'grok', supersetShim('grok'));
    expect(agents.resolveBin('grok', withPath(shimDir))).toBeNull();
  });

  it('skips past the shim to the real binary, whichever comes first on PATH', () => {
    const real = bin(realDir, 'codex', '#!/usr/bin/env node\nmain();\n');
    bin(shimDir, 'codex', supersetShim('codex'));
    // Shim first — the case that actually happens.
    expect(agents.resolveBin('codex', withPath(shimDir, realDir))).toBe(real);
    // Real first — unchanged behaviour.
    expect(agents.resolveBin('codex', withPath(realDir, shimDir))).toBe(real);
  });

  it('tolerates empty segments and missing PATH', () => {
    const p = bin(realDir, 'tolerant', '#!/bin/sh\n');
    expect(agents.resolveBin('tolerant', { PATH: `:${realDir}::` })).toBe(p);
    expect(agents.resolveBin('tolerant', {})).toBeNull();
  });
});
