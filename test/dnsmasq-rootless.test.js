import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import dnsmasq from '../electron/services/dnsmasq.cjs';
import { adminOsascript } from '../electron/services/admin.cjs';

// Rootless DNS (#202): dnsmasq runs as a procman child on a high loopback
// port, reading a WPXen-owned config in the app's data folder; the only
// privileged step is writing the .test resolver file. Everything that touches
// the machine goes through the module's deps seam — the privileged command is
// captured, never run, and the "data folder" and "Homebrew prefix" are temp
// directories.

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

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-dns-data-'));
  prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-dns-brew-'));
  store = makeStore();
  calls = [];
  dnsmasq.__setDeps({
    store,
    getDataDir: () => dataDir,
    getBrewPrefix: () => prefix,
    tmpdir: () => dataDir,
    binExists: () => true,
    resolverExists: () => false,
    legacySetupPresent: () => false,
    // Never probe or resolve for real (see dnsmasq-health.test.js).
    portInUse: async () => false,
    lookup: async () => ['127.0.0.1'],
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

const confPath = () => path.join(dataDir, 'dnsmasq', 'wpxen-dnsmasq.conf');

describe('rootless procman spec', () => {
  it('runs the Homebrew dnsmasq in the foreground, on loopback, on the default high port, reading only our config', () => {
    const spec = dnsmasq.buildSpec();
    expect(spec.name).toBe('dnsmasq');
    expect(spec.bin).toBe(`${prefix}/opt/dnsmasq/sbin/dnsmasq`);
    expect(spec.args).toEqual([
      '--keep-in-foreground',
      `--conf-file=${confPath()}`,
      '--listen-address=127.0.0.1',
      '--port=53535',
      '--bind-interfaces',
      `--pid-file=${path.join(dataDir, 'dnsmasq', 'wpxen-dnsmasq.pid')}`,
      '--log-facility=-',
    ]);
    expect(dnsmasq.DNS_PORT).toBe(53535);
  });

  it('is unprivileged and never takes over another dnsmasq', () => {
    const spec = dnsmasq.buildSpec();
    expect(spec.bin).not.toMatch(/sudo|osascript/);
    expect(spec.args.join(' ')).not.toMatch(/--user|sudo/);
    // A legacy root daemon or the user's own dnsmasq is not ours to kill.
    expect(spec.conflictProbe).toBeUndefined();
    expect(spec.takeover).toBeUndefined();
  });

  it('uses the port persisted in the store', () => {
    store.set('dns.port', 54000);
    expect(dnsmasq.buildSpec().args).toContain('--port=54000');
  });
});

describe('rootless config and resolver content', () => {
  it('answers only *.test with the loopback address', () => {
    expect(dnsmasq.buildConfig()).toBe(
      '# WPXen dnsmasq config — generated on every start, do not edit.\n' +
        '# Answers *.test with the loopback address and nothing else.\n' +
        'no-resolv\n' +
        'no-hosts\n' +
        'no-poll\n' +
        'address=/.test/127.0.0.1\n'
    );
  });

  it('names the loopback address and the port in the resolver file', () => {
    expect(dnsmasq.buildResolverContent()).toBe(
      '# WPXen DNS resolver for .test domains\nnameserver 127.0.0.1\nport 53535\n'
    );
    expect(dnsmasq.buildResolverContent({ port: 54000 })).toContain('port 54000\n');
  });
});

describe('DNS mode decision', () => {
  it('keeps a recorded mode', () => {
    expect(dnsmasq.decideMode({ storedMode: 'rootless', legacySetup: true })).toBe(
      'rootless'
    );
    expect(dnsmasq.decideMode({ storedMode: 'legacy', legacySetup: false })).toBe(
      'legacy'
    );
  });

  it('treats an existing old-style setup as legacy and anything else as rootless', () => {
    expect(dnsmasq.decideMode({ storedMode: undefined, legacySetup: true })).toBe(
      'legacy'
    );
    expect(dnsmasq.decideMode({ storedMode: undefined, legacySetup: false })).toBe(
      'rootless'
    );
    expect(dnsmasq.decideMode({ storedMode: 'garbage', legacySetup: false })).toBe(
      'rootless'
    );
  });

  it('records legacy as soon as it is detected, so the install stays legacy', () => {
    dnsmasq.__setDeps({ legacySetupPresent: () => true });
    expect(dnsmasq.getMode()).toBe('legacy');
    expect(store.data['dns.mode']).toBe('legacy');
  });

  it('does not record rootless until setup has succeeded', () => {
    expect(dnsmasq.getMode()).toBe('rootless');
    expect(store.data['dns.mode']).toBeUndefined();
  });
});

describe('rootless setup', () => {
  it('writes our config, then the resolver file and cache flush in one admin step', () => {
    let staged = null;
    dnsmasq.__setDeps({
      execSync: (cmd) => {
        calls.push({ cmd });
        // The resolver content is staged in a temp file the root step copies.
        staged = fs.readFileSync(path.join(dataDir, 'wpxen-resolver-test'), 'utf8');
      },
    });

    dnsmasq.configureDnsmasq();

    expect(fs.readFileSync(confPath(), 'utf8')).toBe(dnsmasq.buildConfig());
    expect(calls).toHaveLength(1);
    const tmp = path.join(dataDir, 'wpxen-resolver-test');
    expect(calls[0].cmd).toBe(
      adminOsascript(
        `mkdir -p /etc/resolver && cp '${tmp}' '/etc/resolver/test' && chmod 644 '/etc/resolver/test'` +
          ' && dscacheutil -flushcache && killall -HUP mDNSResponder',
        'WPXen wants to configure macOS so that .test sites resolve to your local machine.'
      )
    );
    expect(staged).toBe(
      '# WPXen DNS resolver for .test domains\nnameserver 127.0.0.1\nport 53535\n'
    );
    expect(fs.existsSync(tmp)).toBe(false);
    expect(store.data['dns.mode']).toBe('rootless');
    expect(store.data['dns.port']).toBe(53535);
  });

  it("leaves Homebrew's shared dnsmasq config untouched", () => {
    const shared = path.join(prefix, 'etc', 'dnsmasq.conf');
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.writeFileSync(shared, '# my own dnsmasq\nlisten-address=10.0.0.1\n');

    dnsmasq.configureDnsmasq();

    expect(fs.readFileSync(shared, 'utf8')).toBe(
      '# my own dnsmasq\nlisten-address=10.0.0.1\n'
    );
  });

  it('records nothing when the admin prompt is cancelled', () => {
    dnsmasq.__setDeps({
      execSync: () => {
        throw new Error('User canceled. (-128)');
      },
    });
    expect(() => dnsmasq.configureDnsmasq()).toThrow(/canceled/);
    expect(store.data['dns.mode']).toBeUndefined();
    expect(store.data['dns.port']).toBeUndefined();
  });
});

describe('start / stop by mode', () => {
  it('supervises rootless dnsmasq through procman, writing the config first', async () => {
    await dnsmasq.start();
    expect(fs.existsSync(confPath())).toBe(true);
    expect(calls.map((c) => c.procman || c.brew)).toEqual(['start']);
    expect(calls[0].spec.name).toBe('dnsmasq');

    await dnsmasq.stop();
    await dnsmasq.restart();
    // Restart is stop + start so the port can be probed in between (#204).
    expect(calls.slice(1).map((c) => c.procman)).toEqual(['stop', 'stop', 'start']);
  });

  it('keeps the root brew service in legacy mode, exactly as before', async () => {
    store.set('dns.mode', 'legacy');
    await dnsmasq.start();
    await dnsmasq.stop();
    await dnsmasq.restart();
    expect(calls).toEqual([
      { brew: 'start', n: 'dnsmasq' },
      { brew: 'stop', n: 'dnsmasq' },
      { brew: 'restart', n: 'dnsmasq' },
    ]);
  });

  it('reports rootless running state from procman, not from any dnsmasq on the machine', async () => {
    expect(await dnsmasq.isRunningAsync()).toBe(false);
    dnsmasq.__setDeps({
      procman: {
        status: (name) => ({ state: name === 'dnsmasq' ? 'running' : 'stopped' }),
      },
    });
    expect(await dnsmasq.isRunningAsync()).toBe(true);
  });
});

describe('auto-start on launch', () => {
  it('starts only a rootless setup that has been completed', () => {
    expect(dnsmasq.shouldAutoStart()).toBe(false); // never set up

    store.set('dns.mode', 'rootless');
    dnsmasq.__setDeps({ resolverExists: () => true });
    expect(dnsmasq.shouldAutoStart()).toBe(true);

    store.set('dns.mode', 'legacy'); // root LaunchDaemon starts itself
    expect(dnsmasq.shouldAutoStart()).toBe(false);
  });
});
