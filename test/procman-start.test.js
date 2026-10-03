import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import procman from '../electron/services/procman.cjs';

// start() must tell the truth about a child that dies during startup. One that
// exits straight away goes into crash-restart backoff (1 s, 2 s, 4 s…), which
// never reaches 'failed' inside the ready window — so start() used to resolve
// as if it had worked while the service stayed down and kept respawning.
// Callers that swap versions (PHP) rely on the rejection to roll back.
//
// Real /bin/sh children rather than fakes: the bug lives in how spawn, exit
// and the backoff timer interleave.

let dir;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-procman-'));
  procman.setBaseDir(dir);
});

afterEach(async () => {
  await procman.stop('crashy');
  await procman.stop('slow');
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('procman.start', () => {
  it('rejects when the child keeps exiting during startup, and stops retrying', async () => {
    const spec = {
      name: 'crashy',
      bin: '/bin/sh',
      args: ['-c', 'exit 3'],
      readyProbe: async () => false,
      readyTimeoutMs: 2500,
    };
    await expect(procman.start(spec)).rejects.toThrow(/exited during startup.*3/);
    expect(procman.status('crashy').state).toBe('failed');

    // No respawn left armed: still failed, and no child, a few seconds later.
    await new Promise((r) => setTimeout(r, 2500));
    expect(procman.status('crashy').state).toBe('failed');
  }, 10_000);

  it('still resolves for a child that is alive but slow to report ready', async () => {
    const spec = {
      name: 'slow',
      bin: '/bin/sh',
      args: ['-c', 'sleep 30'],
      readyProbe: async () => false,
      readyTimeoutMs: 1000,
    };
    await expect(procman.start(spec)).resolves.toBeTruthy();
    expect(procman.status('slow').state).toBe('running');
  }, 10_000);
});
