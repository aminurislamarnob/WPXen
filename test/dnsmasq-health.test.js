import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import dgram from 'dgram';
import fs from 'fs';
import os from 'os';
import path from 'path';
import dnsmasq from '../electron/services/dnsmasq.cjs';
import { adminOsascript } from '../electron/services/admin.cjs';

// DNS health (#204): status is judged by a real lookup of a reserved .test
// name through the system resolver, a failed check offers Repair, and a port
// another program holds stops dnsmasq from starting (no crash loop) and
// offers "Use a different port". The lookup, the port probe, the admin prompt
// and procman all come in through the module's deps seam.

let dataDir;
let prefix;
let store;
let calls;
let lookups;

const makeStore = (data = {}) => ({
  data,
  get(k, d) {
    return k in this.data ? this.data[k] : d;
  },
  set(k, v) {
    this.data[k] = v;
  },
});

// A procman fake that remembers whether "our" dnsmasq is up.
function fakeProcman() {
  const pm = {
    pid: null,
    start: async (spec) => {
      calls.push({ procman: 'start', port: spec.meta.port });
      pm.pid = 4242;
    },
    stop: async (name) => {
      calls.push({ procman: 'stop', name });
      pm.pid = null;
    },
    restart: async (spec) => {
      calls.push({ procman: 'restart', port: spec.meta.port });
      pm.pid = 4242;
    },
    status: () => ({ state: pm.pid ? 'running' : 'stopped', pid: pm.pid }),
  };
  return pm;
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-dns-health-'));
  prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-dns-health-brew-'));
  store = makeStore();
  calls = [];
  lookups = [];
  dnsmasq.__resetHealth();
  dnsmasq.__setDeps({
    store,
    getDataDir: () => dataDir,
    getBrewPrefix: () => prefix,
    tmpdir: () => dataDir,
    binExists: () => true,
    resolverExists: () => true,
    legacySetupPresent: () => false,
    execSync: (cmd) => {
      calls.push({ cmd });
    },
    procman: fakeProcman(),
    brew: {
      startBrewServiceSudo: (n) => calls.push({ brew: 'start', n }),
      stopBrewServiceSudo: (n) => calls.push({ brew: 'stop', n }),
      restartBrewServiceSudo: (n) => calls.push({ brew: 'restart', n }),
    },
    lookup: async (name) => {
      lookups.push(name);
      return ['127.0.0.1'];
    },
    portInUse: async () => false,
    lookupTimeoutMs: 3000,
    settleDelayMs: 0,
  });
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(prefix, { recursive: true, force: true });
});

const rootlessSetUp = () => {
  store.set('dns.mode', 'rootless');
  store.set('dns.port', 53535);
};

describe('health decision', () => {
  it('is healthy when the reserved name resolves to the loopback address', () => {
    expect(dnsmasq.decideHealth({ addresses: ['127.0.0.1'] })).toEqual({
      healthy: true,
      message: null,
    });
  });

  it('is an error when the name resolves somewhere else', () => {
    const verdict = dnsmasq.decideHealth({ addresses: ['93.184.216.34'] });
    expect(verdict.healthy).toBe(false);
    expect(verdict.message).toBe(
      '.test names resolve to 93.184.216.34 instead of 127.0.0.1.'
    );
    // Loopback mixed with a stray answer is still wrong.
    expect(dnsmasq.decideHealth({ addresses: ['127.0.0.1', '10.0.0.5'] }).healthy).toBe(
      false
    );
    expect(dnsmasq.decideHealth({ addresses: [] }).healthy).toBe(false);
  });

  it('is an error when the lookup fails', () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND wpxen-probe.test'), {
      code: 'ENOTFOUND',
    });
    expect(dnsmasq.decideHealth({ error: err })).toEqual({
      healthy: false,
      message: ".test names don't resolve on this Mac (ENOTFOUND).",
    });
  });
});

describe('lookup check', () => {
  it('reports healthy from a real lookup of the reserved name', async () => {
    rootlessSetUp();
    const result = await dnsmasq.checkHealth();
    expect(lookups).toEqual(['wpxen-probe.test']);
    expect(result.state).toBe('healthy');
    expect(dnsmasq.getStatusFields()).toEqual({
      health: expect.objectContaining({ state: 'healthy', problem: null }),
      action: null,
      error: null,
    });
  });

  it('turns a deleted or corrupted resolver file into an error with Repair on the next check', async () => {
    rootlessSetUp();
    await dnsmasq.checkHealth();

    // The resolver file is gone: macOS asks the public DNS, which has no .test.
    dnsmasq.__setDeps({
      resolverExists: () => false,
      lookup: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      },
    });
    await dnsmasq.checkHealth();
    expect(dnsmasq.getStatusFields()).toEqual({
      health: expect.objectContaining({ state: 'error', problem: 'lookup' }),
      action: 'repair',
      error: ".test names don't resolve on this Mac (ENOTFOUND).",
    });
  });

  it('gives up on a lookup that hangs', async () => {
    rootlessSetUp();
    dnsmasq.__setDeps({ lookup: () => new Promise(() => {}), lookupTimeoutMs: 20 });
    const result = await dnsmasq.checkHealth();
    expect(result.state).toBe('error');
    expect(result.message).toMatch(/timed out/);
  });

  it('runs and reports correctly in legacy mode too', async () => {
    store.set('dns.mode', 'legacy');
    dnsmasq.__setDeps({ legacySetupPresent: () => true });
    await dnsmasq.checkHealth();
    expect(lookups).toEqual(['wpxen-probe.test']);
    expect(dnsmasq.getStatusFields().health.state).toBe('healthy');

    dnsmasq.__setDeps({ lookup: async () => ['192.168.1.9'] });
    await dnsmasq.checkHealth();
    expect(dnsmasq.getStatusFields()).toMatchObject({
      health: { state: 'error', problem: 'lookup' },
      action: 'repair',
    });
  });

  it('is re-checked from the poller once seeded, at most every maxAgeMs', async () => {
    rootlessSetUp();
    // Not before the launch check has run — no error flash while dnsmasq is
    // still coming up.
    await dnsmasq.refreshHealth({ maxAgeMs: 0 });
    expect(lookups).toHaveLength(0);

    await dnsmasq.checkHealth();
    await dnsmasq.refreshHealth({ maxAgeMs: 60_000 });
    expect(lookups).toHaveLength(1);
    await dnsmasq.refreshHealth({ maxAgeMs: 0 });
    expect(lookups).toHaveLength(2);
  });

  it('skips the lookup before DNS has been set up', async () => {
    dnsmasq.__setDeps({ resolverExists: () => false });
    const result = await dnsmasq.checkHealth();
    expect(lookups).toEqual([]);
    expect(result.state).toBe('unconfigured');
    expect(dnsmasq.getStatusFields().error).toBeNull();
  });
});

const stagedResolver = () => path.join(dataDir, 'wpxen-resolver-test');
const resolverCmd = () =>
  adminOsascript(
    `mkdir -p /etc/resolver && cp '${stagedResolver()}' '/etc/resolver/test' && chmod 644 '/etc/resolver/test'` +
      ' && dscacheutil -flushcache && killall -HUP mDNSResponder',
    'WPXen wants to configure macOS so that .test sites resolve to your local machine.'
  );

describe('Repair', () => {
  it('re-runs setup with one prompt — config, resolver file, restart — and re-checks', async () => {
    rootlessSetUp();
    let resolves = false;
    let staged = null;
    dnsmasq.__setDeps({
      lookup: async () => {
        if (!resolves) throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
        return ['127.0.0.1'];
      },
      execSync: (cmd) => {
        calls.push({ cmd });
        staged = fs.readFileSync(stagedResolver(), 'utf8');
        resolves = true; // the resolver file is back
      },
    });
    await dnsmasq.checkHealth();
    expect(dnsmasq.getStatusFields().action).toBe('repair');

    const result = await dnsmasq.repair();

    expect(calls.filter((c) => c.cmd)).toEqual([{ cmd: resolverCmd() }]);
    expect(staged).toBe(
      '# WPXen DNS resolver for .test domains\nnameserver 127.0.0.1\nport 53535\n'
    );
    expect(
      fs.readFileSync(path.join(dataDir, 'dnsmasq', 'wpxen-dnsmasq.conf'), 'utf8')
    ).toBe(dnsmasq.buildConfig());
    expect(calls.some((c) => c.procman === 'start' || c.procman === 'restart')).toBe(
      true
    );
    expect(result.state).toBe('healthy');
    expect(dnsmasq.getStatusFields().action).toBeNull();
  });

  it('gives macOS a moment to pick the new resolver file up before judging', async () => {
    rootlessSetUp();
    let attempt = 0;
    dnsmasq.__setDeps({
      settleDelayMs: 0,
      lookup: async () => {
        attempt += 1;
        if (attempt < 3) throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
        return ['127.0.0.1'];
      },
    });
    expect((await dnsmasq.repair()).state).toBe('healthy');
    expect(attempt).toBe(3);
  });

  it('changes nothing when the prompt is cancelled', async () => {
    rootlessSetUp();
    dnsmasq.__setDeps({
      execSync: () => {
        throw new Error('User canceled. (-128)');
      },
    });
    await expect(dnsmasq.repair()).rejects.toThrow(/canceled/);
    expect(calls.some((c) => c.procman)).toBe(false);
    expect(store.data['dns.port']).toBe(53535);
  });
});

describe('port conflict', () => {
  it('shows a clear error instead of starting into a crash loop', async () => {
    rootlessSetUp();
    dnsmasq.__setDeps({ portInUse: async (port) => port === 53535 });

    await expect(dnsmasq.start()).rejects.toThrow(
      'Port 53535 is in use by another program, so DNS can’t start. Use a different port to fix it.'
    );
    // procman never spawned it, so there is nothing to crash-restart.
    expect(calls.some((c) => c.procman === 'start')).toBe(false);
    expect(dnsmasq.getStatusFields()).toEqual({
      health: expect.objectContaining({
        state: 'error',
        problem: 'port-conflict',
        port: 53535,
      }),
      action: 'change-port',
      error:
        'Port 53535 is in use by another program, so DNS can’t start. Use a different port to fix it.',
    });

    // A later lookup check (which also fails) doesn't hide the real cause.
    dnsmasq.__setDeps({
      lookup: async () => {
        throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
      },
    });
    await dnsmasq.checkHealth();
    expect(dnsmasq.getStatusFields().action).toBe('change-port');
  });

  it('probes on restart too, after our own instance has let go of the port', async () => {
    rootlessSetUp();
    await dnsmasq.start();
    // Our dnsmasq holds the port; another program grabs it the moment ours stops.
    dnsmasq.__setDeps({ portInUse: async () => true });
    await expect(dnsmasq.restart()).rejects.toThrow(/Port 53535 is in use/);
    expect(dnsmasq.getStatusFields().action).toBe('change-port');
  });

  it('does not mistake our own running dnsmasq for a conflict', async () => {
    rootlessSetUp();
    await dnsmasq.start();
    dnsmasq.__setDeps({ portInUse: async () => true }); // held by us
    await expect(dnsmasq.start()).resolves.toBeUndefined();
  });

  it('Use a different port picks a free high port, persists it and rewrites the resolver file with one prompt', async () => {
    rootlessSetUp();
    const taken = new Set([53535, 53536]);
    let staged = null;
    dnsmasq.__setDeps({
      portInUse: async (port) => taken.has(port),
      execSync: (cmd) => {
        calls.push({ cmd });
        staged = fs.readFileSync(stagedResolver(), 'utf8');
      },
    });
    await expect(dnsmasq.start()).rejects.toThrow(/in use/);

    const result = await dnsmasq.useDifferentPort();

    expect(result.port).toBe(53537);
    expect(calls.filter((c) => c.cmd)).toEqual([{ cmd: resolverCmd() }]);
    expect(staged).toBe(
      '# WPXen DNS resolver for .test domains\nnameserver 127.0.0.1\nport 53537\n'
    );
    expect(store.data['dns.port']).toBe(53537);
    expect(calls.filter((c) => c.procman === 'start').map((c) => c.port)).toEqual([
      53537,
    ]);
    expect(result.health.state).toBe('healthy');
    expect(dnsmasq.getStatusFields().action).toBeNull();
  });

  it('keeps the old port and the error when the prompt is cancelled', async () => {
    rootlessSetUp();
    dnsmasq.__setDeps({
      portInUse: async (port) => port === 53535,
      execSync: () => {
        throw new Error('User canceled. (-128)');
      },
    });
    await expect(dnsmasq.start()).rejects.toThrow(/in use/);
    await expect(dnsmasq.useDifferentPort()).rejects.toThrow(/canceled/);
    expect(store.data['dns.port']).toBe(53535);
    expect(dnsmasq.getStatusFields().action).toBe('change-port');
  });

  it('the chosen port survives an app restart', async () => {
    rootlessSetUp();
    dnsmasq.__setDeps({ portInUse: async (port) => port === 53535 });
    await dnsmasq.useDifferentPort();

    // A relaunch: a fresh store read back from what was persisted.
    const relaunched = makeStore({ ...store.data });
    dnsmasq.__resetHealth();
    dnsmasq.__setDeps({ store: relaunched, procman: fakeProcman() });
    expect(dnsmasq.getPort()).toBe(53536);
    expect(dnsmasq.buildSpec().args).toContain('--port=53536');
    expect(dnsmasq.buildResolverContent()).toContain('port 53536\n');
  });

  it('a migration onto a taken port ends in the port-conflict fix, not a crash loop', async () => {
    store.set('dns.mode', 'legacy');
    dnsmasq.__setDeps({
      legacySetupPresent: () => true,
      sudoersPresent: () => false,
      getBrewPath: () => `${prefix}/bin/brew`,
      portInUse: async (port) => port === 53535,
    });
    await expect(dnsmasq.migrateToRootless()).rejects.toThrow(/Port 53535 is in use/);
    expect(store.data['dns.mode']).toBe('rootless');
    expect(calls.some((c) => c.procman === 'start')).toBe(false);
    expect(dnsmasq.getStatusFields().action).toBe('change-port');
  });

  it('is rootless-only: the legacy root daemon sits on port 53', async () => {
    store.set('dns.mode', 'legacy');
    dnsmasq.__setDeps({ portInUse: async () => true });
    await dnsmasq.start(); // unchanged legacy path, no probe
    expect(calls).toEqual([{ brew: 'start', n: 'dnsmasq' }]);
    await expect(dnsmasq.useDifferentPort()).rejects.toThrow(/legacy/i);
  });
});

describe('port probe', () => {
  it('sees a UDP port another program holds, and a free one as free', async () => {
    const holder = dgram.createSocket('udp4');
    await new Promise((r) => holder.bind(0, '127.0.0.1', r));
    const held = holder.address().port;
    try {
      expect(await dnsmasq.probePortInUse(held)).toBe(true);
    } finally {
      await new Promise((r) => holder.close(r));
    }
    expect(await dnsmasq.probePortInUse(held)).toBe(false);
  });
});
