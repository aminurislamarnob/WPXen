import { describe, it, expect, beforeEach } from 'vitest';
import php from '../electron/services/php.cjs';

// Switching PHP moves two things — the CLI link and the supervised FPM child —
// and a half-finished switch is the one outcome that hurts: on 2026-10-03 the
// new FPM refused to start after the old one had been stopped, leaving every
// site on a 502. These pin the rollback: whatever fails, the version that was
// serving sites is serving them again afterwards, and the CLI agrees with it.

let calls;
let link;
let fpm; // { state, version } — what the fake procman is running
let failStart; // versions whose FPM start should throw
let foreignFpm; // another php-fpm master exists that WPXen didn't spawn

const fakeProcman = {
  status: () => ({ state: fpm.state, meta: { version: fpm.version } }),
  stop: async (name) => {
    calls.push(`stop ${name}`);
    fpm = { state: 'stopped', version: null };
  },
  start: async (spec) => {
    const v = spec.meta.version;
    calls.push(`start ${v}`);
    // Same contract as the real procman: a positive conflict probe refuses.
    if (typeof spec.conflictProbe === 'function' && (await spec.conflictProbe())) {
      throw new Error('php is already running outside WPXen');
    }
    if (failStart.has(v)) {
      fpm = { state: 'stopped', version: null };
      throw new Error(`php ${v} would not start`);
    }
    fpm = { state: 'running', version: v };
  },
};

beforeEach(() => {
  calls = [];
  link = '8.5';
  fpm = { state: 'running', version: '8.5' };
  failStart = new Set();
  foreignFpm = false;
  php.__setDeps({
    procman: fakeProcman,
    fpmSpec: (version) => ({
      name: 'php',
      meta: { version },
      conflictProbe: async () => foreignFpm,
    }),
    activePhpVersion: () => link,
    linkPhp: (v) => {
      calls.push(`link ${v}`);
      if (failStart.has(`link ${v}`)) throw new Error(`cannot link ${v}`);
      link = v;
    },
  });
});

describe('switchPhpVersion', () => {
  it('links the CLI and swaps a running FPM to the new version', async () => {
    await php.switchPhpVersion('8.4');
    expect(calls).toEqual(['link 8.4', 'stop php', 'start 8.4']);
    expect(fpm).toEqual({ state: 'running', version: '8.4' });
    expect(link).toBe('8.4');
  });

  it('only relinks when FPM is not running', async () => {
    fpm = { state: 'stopped', version: null };
    await php.switchPhpVersion('8.4');
    expect(calls).toEqual(['link 8.4']);
    expect(fpm.state).toBe('stopped');
  });

  it('puts the previous FPM and CLI link back when the new FPM will not start', async () => {
    failStart.add('8.4');
    await expect(php.switchPhpVersion('8.4')).rejects.toThrow('php 8.4 would not start');
    expect(calls).toEqual(['link 8.4', 'stop php', 'start 8.4', 'start 8.5', 'link 8.5']);
    expect(fpm).toEqual({ state: 'running', version: '8.5' });
    expect(link).toBe('8.5');
  });

  // The 2026-10-03 incident: a php-fpm master outside WPXen made the conflict
  // check refuse the new version — and then refuse the rollback the same way.
  it('rolls back even when a foreign FPM made the new version refuse to start', async () => {
    foreignFpm = true;
    await expect(php.switchPhpVersion('8.4')).rejects.toThrow('outside WPXen');
    expect(fpm).toEqual({ state: 'running', version: '8.5' });
    expect(link).toBe('8.5');
  });

  it('reports the original failure even if the rollback start fails too', async () => {
    failStart.add('8.4').add('8.5');
    await expect(php.switchPhpVersion('8.4')).rejects.toThrow('php 8.4 would not start');
    expect(link).toBe('8.5');
  });

  it('leaves FPM untouched when the CLI link fails', async () => {
    failStart.add('link 8.4');
    await expect(php.switchPhpVersion('8.4')).rejects.toThrow('cannot link 8.4');
    expect(calls).toEqual(['link 8.4']);
    expect(fpm).toEqual({ state: 'running', version: '8.5' });
  });
});

describe('startPhpFpm', () => {
  it('restores the previous version when the new one fails', async () => {
    failStart.add('8.4');
    await expect(php.startPhpFpm('8.4')).rejects.toThrow();
    expect(fpm).toEqual({ state: 'running', version: '8.5' });
  });

  it('starts directly when nothing is running', async () => {
    fpm = { state: 'stopped', version: null };
    await php.startPhpFpm('8.4');
    expect(calls).toEqual(['start 8.4']);
  });
});

describe('foreignFpmMasters', () => {
  const prefix = '/opt/homebrew';
  const ps = [
    '  100     1 php-fpm: master process (/opt/homebrew/etc/php/8.5/php-fpm.conf)',
    '  200   555 php-fpm: master process (/opt/homebrew/etc/php/8.4/php-fpm.conf)',
    '  201   200 php-fpm: pool www',
    '  300     1 php-fpm: master process (/Users/me/Library/Application Support/Herd/config/php/84/php-fpm.conf)',
    '  400   555 /bin/sh -c pgrep -f "php-fpm: master.*/opt/homebrew/etc/php"',
  ].join('\n');

  it('ignores our own child, pool workers and FPMs outside the Homebrew prefix', () => {
    expect(php.foreignFpmMasters(ps, 555, prefix)).toEqual([100]);
  });

  it('finds nothing when the only master is ours', () => {
    expect(php.foreignFpmMasters(ps.split('\n')[1], 555, prefix)).toEqual([]);
  });
});
