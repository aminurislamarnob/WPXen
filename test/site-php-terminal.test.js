import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import agents from '../electron/services/agents.cjs';
import shellIntegration from '../electron/services/shellIntegration.cjs';

// A Site's terminals get that Site's PHP first on PATH. Setting PATH on the pty
// alone loses to the user's startup files (`eval "$(brew shellenv)"` puts the
// globally linked php back in front), so zsh runs through a ZDOTDIR wrapper
// that sources the user's files and only then prepends the Site's PHP.

const PHP_BIN = '/opt/homebrew/opt/php@8.4/bin';
let tmp;
let ptys;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-site-php-'));
  ptys = [];
  agents.__setDeps({
    spawnPty: (file, args, opts) => {
      const p = {
        spawnedWith: { file, args, opts },
        onData: () => {},
        onExit: () => {},
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      };
      ptys.push(p);
      return p;
    },
    shellEnv: () => ({ PATH: '/usr/bin:/bin', HOME: tmp }),
    userShell: () => '/bin/zsh',
    homedir: () => tmp,
    sitePhpBin: (site) => (site.phpVersion === '8.4' ? PHP_BIN : null),
  });
});

afterEach(() => {
  agents.stopAll();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const site = (over = {}) => ({
  id: 's1',
  name: 'Shop',
  path: tmp,
  phpVersion: '8.4',
  ...over,
});

describe("a Site's terminal", () => {
  it('starts zsh through the wrapper, carrying the Site PHP', () => {
    expect(agents.launch({ site: site(), agentId: 'shell' }).ok).toBe(true);
    const { env } = ptys[0].spawnedWith.opts;
    expect(env.WPXEN_PHP_BIN).toBe(PHP_BIN);
    expect(path.basename(env.ZDOTDIR)).toBe(shellIntegration.ZSH_DIR_NAME);
    expect(env.WPXEN_USER_ZDOTDIR).toBe(tmp);
    expect(env.PATH.split(':')[0]).toBe(PHP_BIN);
  });

  it('is left alone when the Site has no PHP version to pin', () => {
    agents.launch({ site: site({ phpVersion: undefined }), agentId: 'shell' });
    const { env } = ptys[0].spawnedWith.opts;
    expect(env.ZDOTDIR).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin:/bin');
  });

  it("doesn't touch Floating Workspace terminals, which belong to no Site", () => {
    agents.launchFloating({ cwd: tmp });
    expect(ptys[0].spawnedWith.opts.env.ZDOTDIR).toBeUndefined();
  });
});

describe('prefixCommandWithPhp (shells without the wrapper)', () => {
  it('prefixes the agent command for POSIX shells', () => {
    expect(shellIntegration.prefixCommandWithPhp('claude', '/bin/bash', PHP_BIN)).toBe(
      `PATH=${PHP_BIN}:"$PATH" claude`
    );
  });

  it('leaves zsh (wrapped), unknown shells and plain shells alone', () => {
    expect(shellIntegration.prefixCommandWithPhp('claude', '/bin/zsh', PHP_BIN)).toBe(
      'claude'
    );
    expect(
      shellIntegration.prefixCommandWithPhp('claude', '/opt/homebrew/bin/fish', PHP_BIN)
    ).toBe('claude');
    expect(shellIntegration.prefixCommandWithPhp('', '/bin/bash', PHP_BIN)).toBe('');
  });
});

// The real thing: a login zsh whose .zprofile does what `brew shellenv` does.
const hasZsh = fs.existsSync('/bin/zsh');

describe.skipIf(!hasZsh)('the zsh wrapper, run by zsh', () => {
  const run = (env) => {
    const extra = shellIntegration.sitePhpEnv({
      env,
      shell: '/bin/zsh',
      phpBinDir: '/wpxen-test/php/bin',
      baseDir: tmp,
    });
    return execFileSync(
      '/bin/zsh',
      [
        '-il',
        '-c',
        'echo "first=${path[1]}"; echo "rc=$RC login=$LOGIN"; echo "zdotdir=${ZDOTDIR-unset}"; echo "leaked=$(env | grep -c ^WPXEN_)"',
      ],
      { env: { ...env, ...extra, TERM: 'dumb' }, encoding: 'utf8' }
    );
  };

  it("runs the user's startup files, then puts the Site PHP first anyway", () => {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.zprofile'), 'export PATH="/brew/bin:$PATH"\n');
    fs.writeFileSync(path.join(home, '.zshrc'), 'export RC=yes\n');
    fs.writeFileSync(path.join(home, '.zlogin'), 'export LOGIN=yes\n');
    const out = run({ PATH: '/usr/bin:/bin', HOME: home });
    expect(out).toContain('first=/wpxen-test/php/bin');
    expect(out).toContain('rc=yes login=yes');
    expect(out).toContain('zdotdir=unset');
    expect(out).toContain('leaked=0');
  });

  it("uses and restores the user's own ZDOTDIR", () => {
    const home = path.join(tmp, 'home2');
    const zd = path.join(tmp, 'zd');
    fs.mkdirSync(home);
    fs.mkdirSync(zd);
    fs.writeFileSync(path.join(zd, '.zshrc'), 'export RC=custom\n');
    const out = run({ PATH: '/usr/bin:/bin', HOME: home, ZDOTDIR: zd });
    expect(out).toContain('rc=custom');
    expect(out).toContain(`zdotdir=${zd}`);
    expect(out).toContain('first=/wpxen-test/php/bin');
  });
});
