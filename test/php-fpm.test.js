import { describe, it, expect, beforeEach } from 'vitest';
import php from '../electron/services/php.cjs';

// Per-site PHP: one supervised php-fpm per version, each on its own socket.
// These pin the lifecycle rules — which versions run, what the global switch
// is allowed to touch, and that one version failing never takes the others
// (and the Sites on them) down with it.

let calls;
let link; // the CLI `php` version
let slots; // procman slot -> { state, version }
let failStart; // versions whose FPM start should throw
let sites;
const installed = ['8.5', '8.4', '8.3'];

const slotOf = (v) => `php@${v}`;

const fakeProcman = {
  status: (name) => slots[name] || { state: 'stopped' },
  isSupervised: (name) => !!slots[name],
  start: async (spec) => {
    const v = spec.meta.version;
    calls.push(`start ${v}`);
    if (failStart.has(v)) {
      slots[spec.name] = { state: 'failed', error: `php ${v} would not start` };
      throw new Error(`php ${v} would not start`);
    }
    slots[spec.name] = { state: 'running' };
  },
  stop: async (name) => {
    calls.push(`stop ${name}`);
    if (slots[name]) slots[name] = { state: 'stopped' };
  },
};

const running = () =>
  installed.filter((v) => slots[slotOf(v)]?.state === 'running').sort();

beforeEach(() => {
  calls = [];
  link = '8.5';
  slots = {};
  failStart = new Set();
  sites = [];
  php.__setDeps({
    procman: fakeProcman,
    fpmSpec: (version) => ({ name: slotOf(version), meta: { version } }),
    activePhpVersion: () => link,
    installedVersions: () => installed,
    sites: () => sites,
    linkPhp: (v) => {
      calls.push(`link ${v}`);
      link = v;
    },
  });
});

describe('neededPhpVersions', () => {
  it('is every installed version a Site uses, plus the active one, in installed order', () => {
    const s = [{ phpVersion: '8.3' }, { phpVersion: '8.3' }, { phpVersion: '8.5' }];
    expect(php.neededPhpVersions(s, '8.4', installed)).toEqual(['8.5', '8.4', '8.3']);
  });

  it('ignores versions that are not installed and Sites with none recorded', () => {
    const s = [{ phpVersion: '7.4' }, {}, null];
    expect(php.neededPhpVersions(s, '8.5', installed)).toEqual(['8.5']);
  });
});

describe('reconcilePhpFpm', () => {
  it('starts the versions Sites use and stops the ones nothing uses', async () => {
    sites = [{ phpVersion: '8.4' }];
    slots[slotOf('8.3')] = { state: 'running' }; // left over, no Site on it
    await php.reconcilePhpFpm();
    expect(running()).toEqual(['8.4', '8.5']); // 8.5 is active (phpMyAdmin)
    expect(calls).toContain('stop php@8.3');
  });

  it('leaves versions that are already up alone', async () => {
    sites = [{ phpVersion: '8.5' }];
    slots[slotOf('8.5')] = { state: 'running' };
    await php.reconcilePhpFpm();
    expect(calls).toEqual([]);
  });

  it('keeps starting the others when one version fails, and reports it', async () => {
    sites = [{ phpVersion: '8.4' }, { phpVersion: '8.3' }];
    failStart.add('8.4');
    const { errors } = await php.reconcilePhpFpm();
    expect(running()).toEqual(['8.3', '8.5']);
    expect(errors).toEqual([{ version: '8.4', error: 'php 8.4 would not start' }]);
  });
});

describe('switchPhpVersion', () => {
  it('relinks the CLI and starts the new version without stopping any Site', async () => {
    sites = [{ phpVersion: '8.5' }];
    slots[slotOf('8.5')] = { state: 'running' };
    await php.switchPhpVersion('8.4');
    expect(link).toBe('8.4');
    // 8.5 still serves its Site; 8.4 now runs for phpMyAdmin.
    expect(running()).toEqual(['8.4', '8.5']);
    expect(calls).not.toContain('stop php@8.5');
  });

  it('stops the old active version once no Site needs it', async () => {
    sites = [{ phpVersion: '8.4' }];
    slots[slotOf('8.5')] = { state: 'running' };
    slots[slotOf('8.4')] = { state: 'running' };
    await php.switchPhpVersion('8.4');
    expect(running()).toEqual(['8.4']);
  });

  it('puts the CLI link back when the new version will not start, and stops nothing', async () => {
    sites = [{ phpVersion: '8.5' }];
    slots[slotOf('8.5')] = { state: 'running' };
    failStart.add('8.4');
    await expect(php.switchPhpVersion('8.4')).rejects.toThrow('php 8.4 would not start');
    expect(link).toBe('8.5');
    expect(running()).toEqual(['8.5']);
    expect(calls.filter((c) => c.startsWith('stop'))).toEqual([]);
  });
});

describe('getFpmStatus', () => {
  it('lists the versions up and is running when any is', () => {
    slots[slotOf('8.5')] = { state: 'running' };
    slots[slotOf('8.4')] = { state: 'running' };
    expect(php.getFpmStatus()).toMatchObject({
      state: 'running',
      versions: ['8.5', '8.4'],
    });
  });

  it('surfaces a failed version first, naming it', () => {
    slots[slotOf('8.5')] = { state: 'running' };
    slots[slotOf('8.3')] = { state: 'failed', error: 'bad config' };
    expect(php.getFpmStatus()).toMatchObject({
      state: 'failed',
      error: 'PHP 8.3: bad config',
      versions: ['8.5'],
    });
  });

  it('is stopped when nothing is up', () => {
    expect(php.getFpmStatus()).toMatchObject({ state: 'stopped', versions: [] });
  });
});

describe('buildFpmConfig', () => {
  const conf = php.buildFpmConfig({ version: '8.4', prefix: '/opt/homebrew' });

  it("listens on the version's own socket, never the shared 127.0.0.1:9000", () => {
    expect(conf).toContain('listen = /opt/homebrew/var/run/wpxen/php8.4.sock');
    expect(conf).not.toMatch(/9000/);
    expect(php.fpmSocketPath('8.4', '/opt/homebrew')).toBe(
      '/opt/homebrew/var/run/wpxen/php8.4.sock'
    );
  });

  it('names its pool and pid per version, so two versions never clash', () => {
    const other = php.buildFpmConfig({ version: '8.5', prefix: '/opt/homebrew' });
    expect(conf).toContain('[wpxen-8.4]');
    expect(other).toContain('[wpxen-8.5]');
    expect(conf).toContain('pid = /opt/homebrew/var/run/wpxen/php8.4-fpm.pid');
    expect(conf).toContain('daemonize = no');
  });
});
