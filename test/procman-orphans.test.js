import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import procman from '../electron/services/procman.cjs';

// reconcileOrphans() runs on launch to clear children a hard crash of the
// previous run left behind, by their pid files. It ran *after* registerIpc
// had already started the Remote Access tunnel, whose fresh pid file looked
// exactly like an orphan's — so launch killed this run's own tunnel. The
// rule (after Orca's daemon handling): a pid file alone never condemns a
// process; it must be running the recorded binary *and* not be one of ours.

let dir;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-procman-orphans-'));
  procman.setBaseDir(dir);
});

afterEach(async () => {
  await procman.stop('live-child');
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('procman.reconcileOrphans', () => {
  it("never kills this run's own supervised child", async () => {
    await procman.start({
      name: 'live-child',
      // Its command line carries the recorded binary, exactly like the
      // tunnel's — the case the binary check alone can't tell apart.
      bin: '/bin/sleep',
      args: ['30'],
    });
    const { pid } = procman.status('live-child');
    expect(pid).toBeTruthy();
    await procman.reconcileOrphans();
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(procman.status('live-child')).toMatchObject({ state: 'running', pid });
  }, 10_000);

  it('leaves a recycled pid alone when it runs some other binary', async () => {
    // Our own test process: alive, but not the recorded binary.
    fs.mkdirSync(path.join(dir, 'run'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'run', 'stale.pid'),
      JSON.stringify({ pid: process.pid, bin: '/no/such/daemon' })
    );
    await procman.reconcileOrphans();
    expect(fs.existsSync(path.join(dir, 'run', 'stale.pid'))).toBe(false);
  });
});
