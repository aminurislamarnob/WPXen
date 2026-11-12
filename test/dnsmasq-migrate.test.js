import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import dnsmasq from '../electron/services/dnsmasq.cjs';
import { adminOsascript } from '../electron/services/admin.cjs';

// Migration from the legacy root dnsmasq to rootless (#203). One admin step
// stops and unregisters the root service, deletes every WPXen-generation
// sudoers file and rewrites the resolver with the port; only after it
// succeeds does the app clean Homebrew's shared config, record the mode and
// start the rootless child. The privileged command is captured, never run;
// the "data folder" and "Homebrew prefix" are temp directories.

let dataDir;
let prefix;
let store;
let calls;

const makeStore = (data = {}) => ({
  data,
  get(k, d) {
    return k in this.data ? this.data[k] : d;
  },
  set(k, v) {
    this.data[k] = v;
  },
});

const sharedConf = () => path.join(prefix, 'etc', 'dnsmasq.conf');
const writeShared = (content) => {
  fs.mkdirSync(path.dirname(sharedConf()), { recursive: true });
  fs.writeFileSync(sharedConf(), content);
};

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-dnsmig-data-'));
  prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-dnsmig-brew-'));
  store = makeStore({ 'dns.mode': 'legacy' });
  calls = [];
  dnsmasq.__setDeps({
    store,
    getDataDir: () => dataDir,
    getBrewPrefix: () => prefix,
    getBrewPath: () => `${prefix}/bin/brew`,
    tmpdir: () => dataDir,
    binExists: () => true,
    resolverExists: () => true,
    legacySetupPresent: () => true,
    sudoersPresent: () => false,
    execSync: (cmd) => {
      calls.push({ cmd });
    },
    procman: {
      start: async (spec) => calls.push({ procman: 'start', spec }),
      stop: async (name) => calls.push({ procman: 'stop', name }),
      restart: async (spec) => calls.push({ procman: 'restart', spec }),
      status: () => ({ state: 'stopped' }),
    },
    brew: {
      startBrewServiceSudo: (n) => calls.push({ brew: 'start', n }),
      stopBrewServiceSudo: (n) => calls.push({ brew: 'stop', n }),
      restartBrewServiceSudo: (n) => calls.push({ brew: 'restart', n }),
    },
  });
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(prefix, { recursive: true, force: true });
});

const ROOT_STOP =
  `(PATH=${'PREFIX'}/bin:$PATH ${'PREFIX'}/bin/brew services stop dnsmasq` +
  ' || launchctl bootout system/homebrew.mxcl.dnsmasq || true)' +
  " && rm -f '/Library/LaunchDaemons/homebrew.mxcl.dnsmasq.plist'";
const rootStop = () => ROOT_STOP.replaceAll('PREFIX', prefix);
const SUDOERS_RM =
  "rm -f '/etc/sudoers.d/wpxen' '/etc/sudoers.d/wpdevpilot' '/etc/sudoers.d/wpherd'";
const resolverWrite = (tmp) =>
  `mkdir -p /etc/resolver && cp '${tmp}' '/etc/resolver/test' && chmod 644 '/etc/resolver/test'` +
  ' && dscacheutil -flushcache && killall -HUP mDNSResponder';
const MIGRATE_REASON =
  'WPXen wants to move .test DNS off its root service and remove the ' +
  'passwordless permission it installed. It will not need your password for ' +
  'DNS again.';

describe('the notice', () => {
  it('is needed while DNS is legacy, and not once it is rootless', () => {
    expect(dnsmasq.migrationNeeded()).toBe(true);
    store.set('dns.mode', 'rootless');
    expect(dnsmasq.migrationNeeded()).toBe(false);
  });

  it('is needed on a rootless install that still has a sudoers grant', () => {
    store.set('dns.mode', 'rootless');
    dnsmasq.__setDeps({ sudoersPresent: () => true });
    expect(dnsmasq.migrationNeeded()).toBe(true);
  });

  it('never prompts by itself — deciding it runs nothing privileged', () => {
    dnsmasq.migrationNeeded();
    dnsmasq.getMode();
    expect(calls).toEqual([]);
  });
});

describe('the privileged migration step', () => {
  it('stops and unregisters the root service, removes every sudoers file and writes the resolver with the port, in one prompt', async () => {
    let staged = null;
    dnsmasq.__setDeps({
      execSync: (cmd) => {
        calls.push({ cmd });
        staged = fs.readFileSync(path.join(dataDir, 'wpxen-resolver-test'), 'utf8');
      },
    });

    await dnsmasq.migrateToRootless();

    const privileged = calls.filter((c) => c.cmd);
    expect(privileged).toHaveLength(1);
    const tmp = path.join(dataDir, 'wpxen-resolver-test');
    expect(privileged[0].cmd).toBe(
      adminOsascript(
        `${rootStop()} && ${SUDOERS_RM} && ${resolverWrite(tmp)}`,
        MIGRATE_REASON
      )
    );
    expect(staged).toBe(
      '# WPXen DNS resolver for .test domains\nnameserver 127.0.0.1\nport 53535\n'
    );
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it("on a rootless install it leaves any root dnsmasq alone — it isn't WPXen's", async () => {
    store.set('dns.mode', 'rootless');
    dnsmasq.__setDeps({ sudoersPresent: () => true });

    await dnsmasq.migrateToRootless();

    const tmp = path.join(dataDir, 'wpxen-resolver-test');
    expect(calls.filter((c) => c.cmd).map((c) => c.cmd)).toEqual([
      adminOsascript(`${SUDOERS_RM} && ${resolverWrite(tmp)}`, MIGRATE_REASON),
    ]);
  });

  it('uses the port already persisted in the store', async () => {
    store.set('dns.port', 54000);
    let staged = null;
    dnsmasq.__setDeps({
      execSync: () => {
        staged = fs.readFileSync(path.join(dataDir, 'wpxen-resolver-test'), 'utf8');
      },
    });
    await dnsmasq.migrateToRootless();
    expect(staged).toContain('port 54000\n');
  });
});

describe('after the step succeeds', () => {
  it('records rootless and the port, then starts the rootless dnsmasq through procman', async () => {
    await dnsmasq.migrateToRootless();

    expect(store.data['dns.mode']).toBe('rootless');
    expect(store.data['dns.port']).toBe(53535);
    const started = calls.filter((c) => c.procman === 'start');
    expect(started).toHaveLength(1);
    expect(started[0].spec.args).toContain('--port=53535');
    // The root service is the privileged step's to stop — no brew service
    // call, which would prompt a second time.
    expect(calls.some((c) => c.brew)).toBe(false);
    expect(dnsmasq.migrationNeeded()).toBe(false);
  });

  it("removes exactly WPXen's two lines from Homebrew's shared config", async () => {
    const before =
      '# Homebrew dnsmasq config\n' +
      'listen-address=10.0.0.1\n' +
      '# address=/double-click.net/127.0.0.1\n';
    writeShared(
      `${before}\n# WPXen: Route *.test to localhost\naddress=/.test/127.0.0.1\n`
    );

    await dnsmasq.migrateToRootless();

    expect(fs.readFileSync(sharedConf(), 'utf8')).toBe(before);
  });
});

describe('cancel or failure', () => {
  const cancel = () =>
    dnsmasq.__setDeps({
      execSync: () => {
        throw new Error('User canceled. (-128)');
      },
    });

  it('records nothing, starts nothing, and leaves the shared config and the notice in place', async () => {
    const shared =
      '# mine\n\n# WPXen: Route *.test to localhost\naddress=/.test/127.0.0.1\n';
    writeShared(shared);
    cancel();

    await expect(dnsmasq.migrateToRootless()).rejects.toThrow(/canceled/);

    expect(store.data['dns.mode']).toBe('legacy');
    expect(store.data['dns.port']).toBeUndefined();
    expect(calls.some((c) => c.procman)).toBe(false);
    expect(fs.readFileSync(sharedConf(), 'utf8')).toBe(shared);
    expect(fs.existsSync(path.join(dataDir, 'wpxen-resolver-test'))).toBe(false);
    expect(dnsmasq.migrationNeeded()).toBe(true);
  });

  it('keeps legacy start and stop on the root brew service', async () => {
    cancel();
    await expect(dnsmasq.migrateToRootless()).rejects.toThrow();
    await dnsmasq.start();
    await dnsmasq.stop();
    expect(calls).toEqual([
      { brew: 'start', n: 'dnsmasq' },
      { brew: 'stop', n: 'dnsmasq' },
    ]);
  });

  it('asks for no password when dnsmasq is not installed', async () => {
    dnsmasq.__setDeps({ binExists: () => false });
    await expect(dnsmasq.migrateToRootless()).rejects.toThrow(/not installed/);
    expect(calls).toEqual([]);
    expect(store.data['dns.mode']).toBe('legacy');
  });
});

describe('shared dnsmasq.conf cleanup', () => {
  const strip = dnsmasq.removeLegacyConfLines;
  const block = (name) =>
    `# ${name}: Route *.test to localhost\naddress=/.test/127.0.0.1\n`;

  it('recognises the comment under every app generation', () => {
    for (const name of ['WPXen', 'WPDevPilot', 'WPHerd']) {
      expect(strip(`port=5300\n\n${block(name)}`)).toBe('port=5300\n');
    }
  });

  it('removes the blank line WPXen added before its block, and nothing above it', () => {
    // Original ended in "\n" then a user blank line; the append added one more.
    expect(strip(`a=1\n\n\n${block('WPXen')}`)).toBe('a=1\n\n');
  });

  it('restores a file that had no trailing newline byte-for-byte', () => {
    // The append's leading "\n" terminated the user's last line.
    expect(strip(`a=1\n${block('WPHerd')}`)).toBe('a=1');
  });

  it('keeps content the user added after the block', () => {
    expect(strip(`a=1\n\n${block('WPDevPilot')}b=2\n`)).toBe('a=1\nb=2\n');
  });

  it('never joins two lines when the block sits mid-file without a blank line', () => {
    expect(strip(`a=1\n${block('WPXen')}b=2\n`)).toBe('a=1\nb=2\n');
  });

  it('empties a file that held only the block', () => {
    expect(strip(`\n${block('WPXen')}`)).toBe('');
  });

  it("leaves an address line that isn't under WPXen's comment", () => {
    const mine = '# my own\naddress=/.test/127.0.0.1\n';
    expect(strip(mine)).toBe(mine);
    const other = '# Foo: Route *.test to localhost\naddress=/.test/127.0.0.1\n';
    expect(strip(other)).toBe(other);
  });

  it('leaves a file without the block unchanged', () => {
    const content = '# Homebrew\n#listen-address=\n';
    expect(strip(content)).toBe(content);
  });

  it('does not create the shared config when it is missing', async () => {
    await dnsmasq.migrateToRootless();
    expect(fs.existsSync(sharedConf())).toBe(false);
  });
});
