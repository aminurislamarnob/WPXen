import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nginx from '../electron/services/nginx.cjs';

// "Is nginx running?" gates starting it: a positive answer before our own
// start reads as "already running outside WPXen" and the start is refused.
// The probe used to be `pgrep -f '[/ ]nginx'` through a shell, so anything
// whose command line merely mentioned nginx — `tail -f …/nginx/error.log`, an
// editor on nginx.conf, even the probe's own `sh -c` — kept nginx from
// starting. It must match nginx's processes and nothing else.

describe('isNginxCommand', () => {
  it.each([
    'nginx: master process /opt/homebrew/opt/nginx/bin/nginx -g daemon off;',
    'nginx: worker process',
    '/opt/homebrew/opt/nginx/bin/nginx -g daemon off;',
    'nginx -g daemon off;',
    '/usr/local/bin/nginx',
  ])('matches an nginx process: %s', (cmd) => {
    expect(nginx.isNginxCommand(cmd)).toBe(true);
  });

  it.each([
    'tail -f /opt/homebrew/var/log/nginx/error.log',
    'vim /opt/homebrew/etc/nginx/nginx.conf',
    '/bin/sh -c pgrep -x nginx || pgrep -f [/ ]nginx',
    '/bin/zsh -c grep -h fastcgi_pass /opt/homebrew/etc/nginx/servers/a.conf',
    'nginx-ui serve',
    '/usr/local/bin/nginxfmt site.conf',
  ])('ignores a process that only mentions nginx: %s', (cmd) => {
    expect(nginx.isNginxCommand(cmd)).toBe(false);
  });
});

// Against real processes, through the real pgrep.
describe('isRunningAsync', () => {
  let tmp;
  let realNginxUp;
  const children = [];

  const startAndSettle = async (bin, args) => {
    const child = spawn(bin, args, { stdio: 'ignore' });
    children.push(child);
    await new Promise((r) => setTimeout(r, 300));
    return child;
  };

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-nginx-probe-'));
    // A machine (a dev's) may genuinely have nginx up; the negative case
    // can only be judged on one that doesn't.
    realNginxUp = await nginx.isRunningAsync();
  });

  afterAll(() => {
    for (const c of children) c.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('is not fooled by a process whose command line mentions nginx', async (ctx) => {
    if (realNginxUp) ctx.skip();
    // A compound command keeps sh alive (a simple one would exec `sleep` and
    // drop the text), with the nginx path as its $0 — so it's really there:
    // `/bin/sh -c sleep 30; true /opt/homebrew/var/log/nginx/error.log`.
    await startAndSettle('/bin/sh', [
      '-c',
      'sleep 30; true',
      '/opt/homebrew/var/log/nginx/error.log',
    ]);
    expect(await nginx.isRunningAsync()).toBe(false);
    expect(nginx.isRunning()).toBe(false);
  });

  it('sees a process that really is an nginx binary', async () => {
    // A symlink named nginx: argv[0] is its path, the binary is untouched.
    // (A *copy* of /bin/sleep gets SIGKILLed by macOS code signing.)
    const fake = path.join(tmp, 'nginx');
    fs.symlinkSync('/bin/sleep', fake);
    await startAndSettle(fake, ['30']);
    expect(await nginx.isRunningAsync()).toBe(true);
    expect(nginx.isRunning()).toBe(true);
  });
});
