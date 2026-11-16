import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parsePsTable,
  descendantPids,
  readSessionId,
} from '../electron/services/claudeRegistry.cjs';

describe('claudeRegistry', () => {
  it('parses ps output', () => {
    expect(parsePsTable('  1     0\n 42    1\nbogus\n\n')).toEqual([
      [1, 0],
      [42, 1],
    ]);
  });

  it('walks only the subtree under the root, nearest first', () => {
    const table = [
      [10, 1],
      [20, 10],
      [30, 20],
      [21, 10],
      [99, 1],
    ];
    expect(descendantPids(10, table)).toEqual([20, 21, 30]);
    expect(descendantPids(99, table)).toEqual([]);
  });

  it('reads the sessionId from <pid>.json only, matching its pid', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-claude-reg-'));
    try {
      fs.writeFileSync(
        path.join(dir, '300.json'),
        JSON.stringify({ pid: 300, sessionId: 'uuid-a', cwd: '/x' })
      );
      fs.writeFileSync(
        path.join(dir, '301.json'),
        JSON.stringify({ pid: 999, sessionId: 'no' })
      );
      fs.writeFileSync(path.join(dir, '302.json'), '{not json');
      expect(readSessionId(300, dir)).toBe('uuid-a');
      expect(readSessionId(301, dir)).toBeNull();
      expect(readSessionId(302, dir)).toBeNull();
      expect(readSessionId(303, dir)).toBeNull();
      expect(readSessionId(-1, dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
