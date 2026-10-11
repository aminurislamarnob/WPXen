import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import remoteAccess, {
  VERIFY_REASONS,
  HOST_ID_KEY,
  TOKEN_KEY,
} from '../electron/services/remoteAccess.cjs';
import {
  buildRemoteTunnelSpec,
  REMOTE_TUNNEL_NAME,
} from '../electron/services/cloudflared.cjs';
import { PROTOCOL_VERSION, HEALTH_PATH } from '../shared/remote-protocol/index.cjs';
import {
  saveSecret,
  loadSecret,
  clearSecret,
} from '../electron/services/secureSecrets.cjs';

// Remote Access tunnel (#141): supervised cloudflared, encrypted token,
// hostname verification. procman, fetch, store, safeStorage and config all
// arrive through `__setDeps`; the child is fake, the assertions are on the
// spec we build, the states we derive and the reasons we report.

function fakeStore(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    get(key, fallback) {
      const value = key.split('.').reduce((obj, k) => obj?.[k], data);
      return value !== undefined ? value : fallback;
    },
    set(key, value) {
      const keys = key.split('.');
      let obj = data;
      for (let i = 0; i < keys.length - 1; i++) {
        if (typeof obj[keys[i]] !== 'object' || obj[keys[i]] === null) obj[keys[i]] = {};
        obj = obj[keys[i]];
      }
      obj[keys[keys.length - 1]] = value;
    },
    delete(key) {
      const keys = key.split('.');
      const parent = keys.slice(0, -1).reduce((obj, k) => obj?.[k], data);
      if (parent) delete parent[keys[keys.length - 1]];
    },
  };
}

// Reversible toy cipher: proves ciphertext (not plaintext) reaches the store.
function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (cipher) =>
      Buffer.from(cipher.toString('utf8').replace(/^enc:/, ''), 'utf8'),
  };
}

function fakeProcman() {
  const starts = [];
  let procState = {
    state: 'stopped',
    pid: null,
    meta: null,
    restarts: 0,
    lastExitCode: null,
    error: null,
  };
  return {
    starts,
    setProcState(patch) {
      procState = { ...procState, ...patch };
    },
    async start(spec) {
      starts.push(spec);
      procState = {
        state: 'running',
        pid: 4242,
        meta: spec.meta || null,
        restarts: 0,
        lastExitCode: null,
        error: null,
      };
      return { ...procState };
    },
    async stop() {
      procState = { ...procState, state: 'stopped', pid: null };
    },
    status() {
      return { ...procState };
    },
  };
}

let store;
let safeStorage;
let procman;
let config;
let fetchHandler;

beforeEach(() => {
  store = fakeStore();
  safeStorage = fakeSafeStorage();
  procman = fakeProcman();
  config = { enabled: true, port: 6780, hostname: 'wpxen.example.com' };
  fetchHandler = () => {
    throw new Error('fetch not stubbed for this test');
  };
  remoteAccess.__setDeps({
    store,
    safeStorage,
    procman,
    // The real spec builder against a fake binary path, so the assertions on
    // args/env cover the code that ships.
    cloudflared: {
      isInstalled: () => true,
      getCloudflaredPath: () => '/fake/bin/cloudflared',
      REMOTE_TUNNEL_NAME,
      buildRemoteTunnelSpec: (args) => buildRemoteTunnelSpec(args),
    },
    randomId: () => 'test-nonce',
    fetch: (...args) => fetchHandler(...args),
    getRemoteConfig: () => ({ ...config }),
  });
});

afterEach(() => {
  remoteAccess.dispose();
});

function jsonResponse(obj, ok = true, status = 200) {
  return { ok, status, json: async () => obj };
}

describe('tunnel token', () => {
  it('stores only ciphertext; the store file never sees the token', async () => {
    await remoteAccess.setToken('cf-secret-token');
    expect(remoteAccess.tokenSaved()).toBe(true);
    expect(JSON.stringify(store.data)).not.toContain('cf-secret-token');
    const stored = store.data[TOKEN_KEY];
    expect(typeof stored).toBe('string');
    expect(Buffer.from(stored, 'base64').toString('utf8')).toBe('enc:cf-secret-token');
  });

  it('refuses an empty token and a missing secure store', async () => {
    await expect(remoteAccess.setToken('')).rejects.toThrow();
    await expect(remoteAccess.setToken('   ')).rejects.toThrow();
    remoteAccess.__setDeps({
      safeStorage: fakeSafeStorage(false),
    });
    await expect(remoteAccess.setToken('x')).rejects.toThrow(/secure storage/i);
    expect(remoteAccess.tokenSaved()).toBe(false);
  });

  it('clears the token', async () => {
    await remoteAccess.setToken('cf-secret-token');
    await remoteAccess.clearToken();
    expect(remoteAccess.tokenSaved()).toBe(false);
  });
});

describe('supervised tunnel child', () => {
  it('uses a wpxen-prefixed procman name', () => {
    expect(REMOTE_TUNNEL_NAME.startsWith('wpxen')).toBe(true);
  });

  it('starts the child with the token in env, never in args', async () => {
    await remoteAccess.setToken('cf-secret-token');
    await remoteAccess.syncTunnel();
    expect(procman.starts).toHaveLength(1);
    const [spec] = procman.starts;
    expect(spec.name).toBe(REMOTE_TUNNEL_NAME);
    expect(spec.env.TUNNEL_TOKEN).toBe('cf-secret-token');
    expect(spec.args.join(' ')).not.toContain('cf-secret-token');
    expect(spec.args).toContain('tunnel');
    expect(spec.args).toContain('run');
  });

  it('does not start without both Remote Access on and a token', async () => {
    config.enabled = false;
    await remoteAccess.setToken('cf-secret-token');
    await remoteAccess.syncTunnel();
    expect(procman.starts).toHaveLength(0);
    expect(remoteAccess.getStatus().tunnel.state).toBe('not-configured');

    config.enabled = true;
    await remoteAccess.clearToken();
    await remoteAccess.syncTunnel();
    expect(procman.starts).toHaveLength(0);
  });

  it('stops the child when switched off, when the token is removed, and on dispose', async () => {
    await remoteAccess.setToken('cf-secret-token');
    await remoteAccess.syncTunnel();
    expect(procman.status().state).toBe('running');

    config.enabled = false;
    await remoteAccess.syncTunnel();
    expect(procman.status().state).toBe('stopped');

    config.enabled = true;
    await remoteAccess.syncTunnel();
    await remoteAccess.clearToken();
    expect(procman.status().state).toBe('stopped');
  });

  it('derives starting, connected, reconnecting and error from the child and its ready probe', async () => {
    await remoteAccess.setToken('cf-secret-token');
    fetchHandler = async (url) => {
      expect(String(url)).toMatch(/\/ready$/);
      return jsonResponse({}, true);
    };
    await remoteAccess.syncTunnel();
    expect(remoteAccess.getStatus().tunnel.state).toBe('connected');

    fetchHandler = async () => {
      throw new Error('socket hang up');
    };
    await remoteAccess.refreshTunnelState();
    expect(remoteAccess.getStatus().tunnel.state).toBe('reconnecting');

    procman.setProcState({ state: 'starting', pid: null });
    await remoteAccess.refreshTunnelState();
    expect(remoteAccess.getStatus().tunnel.state).toBe('starting');

    procman.setProcState({ state: 'failed', error: 'exited during startup' });
    await remoteAccess.refreshTunnelState();
    expect(remoteAccess.getStatus().tunnel).toMatchObject({
      state: 'error',
      reason: 'exited during startup',
    });
  });

  it('restarts the child when the port changes', async () => {
    await remoteAccess.setToken('cf-secret-token');
    await remoteAccess.syncTunnel();
    config.port = 6999;
    await remoteAccess.syncTunnel();
    expect(procman.starts).toHaveLength(2);
  });
});

describe('hostname verification', () => {
  it('publishes the five documented reasons', () => {
    expect([...VERIFY_REASONS].sort()).toEqual(
      ['connection', 'dns', 'timeout', 'wrong-port', 'wrong-server'].sort()
    );
  });

  async function verified() {
    store.set(HOST_ID_KEY, 'test-host-id');
    await remoteAccess.setToken('cf-secret-token');
    return remoteAccess.verifyHostname();
  }

  it('passes when the hostname echoes the nonce and this host identity', async () => {
    fetchHandler = async (url) => {
      expect(String(url)).toBe(
        `https://wpxen.example.com${HEALTH_PATH}?nonce=test-nonce`
      );
      return jsonResponse({
        nonce: 'test-nonce',
        hostId: 'test-host-id',
        protocolVersion: PROTOCOL_VERSION,
      });
    };
    remoteAccess.__setDeps({ randomId: () => 'test-nonce' });
    const result = await verified();
    expect(result).toEqual({ ok: true });
    expect(remoteAccess.getStatus().verification.state).toBe('ok');
  });

  it('fails distinctively for DNS, connection, timeout, wrong server and wrong port', async () => {
    const cases = [
      {
        reason: 'dns',
        fetch: async () => {
          const err = new TypeError('fetch failed');
          err.cause = { code: 'ENOTFOUND' };
          throw err;
        },
      },
      {
        reason: 'connection',
        fetch: async () => {
          const err = new TypeError('fetch failed');
          err.cause = { code: 'ECONNREFUSED' };
          throw err;
        },
      },
      {
        reason: 'timeout',
        fetch: async () => {
          const err = new Error('signal timed out');
          err.name = 'AbortError';
          throw err;
        },
      },
      {
        reason: 'wrong-server',
        fetch: async () =>
          jsonResponse({
            nonce: 'test-nonce',
            hostId: 'another-mac',
            protocolVersion: 1,
          }),
      },
      {
        reason: 'wrong-server',
        fetch: async () =>
          jsonResponse({
            nonce: 'stale-nonce',
            hostId: 'test-host-id',
            protocolVersion: 1,
          }),
      },
      {
        reason: 'wrong-port',
        fetch: async () => ({ ok: false, status: 502, json: async () => ({}) }),
      },
      {
        reason: 'wrong-port',
        fetch: async () => jsonResponse({ totally: 'unrelated' }),
      },
    ];
    for (const { reason, fetch } of cases) {
      fetchHandler = fetch;
      const result = await verified();
      expect(result, reason).toEqual({ ok: false, reason });
      expect(remoteAccess.getStatus().verification).toMatchObject({
        state: 'failed',
        reason,
      });
    }
  });
});

describe('secureSecrets helper', () => {
  const KEY = 'wpxenTestSecret';

  it('round-trips through ciphertext', () => {
    saveSecret({ store, safeStorage, key: KEY, value: 's3cret' });
    expect(store.data[KEY]).not.toContain('s3cret');
    expect(loadSecret({ store, safeStorage, key: KEY })).toBe('s3cret');
  });

  it('reads null when nothing was saved and clears', () => {
    expect(loadSecret({ store, safeStorage, key: KEY })).toBeNull();
    saveSecret({ store, safeStorage, key: KEY, value: 's3cret' });
    clearSecret({ store, key: KEY });
    expect(loadSecret({ store, safeStorage, key: KEY })).toBeNull();
  });

  it('refuses to save when encryption is unavailable', () => {
    expect(() =>
      saveSecret({ store, safeStorage: fakeSafeStorage(false), key: KEY, value: 'x' })
    ).toThrow(/secure storage/i);
  });
});

describe('buildRemoteTunnelSpec', () => {
  it('builds a supervised spec with the token in env and a metrics ready probe', async () => {
    const spec = buildRemoteTunnelSpec({
      bin: '/opt/homebrew/bin/cloudflared',
      token: 'cf-secret-token',
      port: 6780,
      metricsPort: 41234,
    });
    expect(spec.name).toBe(REMOTE_TUNNEL_NAME);
    expect(spec.bin).toBe('/opt/homebrew/bin/cloudflared');
    expect(spec.args.join(' ')).toContain('--metrics 127.0.0.1:41234');
    expect(spec.args.join(' ')).not.toContain('cf-secret-token');
    expect(spec.env.TUNNEL_TOKEN).toBe('cf-secret-token');

    let readyUrl = null;
    const probe = buildRemoteTunnelSpec({
      bin: '/opt/homebrew/bin/cloudflared',
      token: 't',
      port: 6780,
      metricsPort: 41234,
      fetchImpl: async (url, opts) => {
        readyUrl = String(url);
        expect(opts.signal).toBeDefined();
        return { ok: true };
      },
    }).readyProbe;
    await expect(probe()).resolves.toBe(true);
    expect(readyUrl).toBe('http://127.0.0.1:41234/ready');
  });

  it('refuses without a binary', () => {
    expect(() =>
      buildRemoteTunnelSpec({ bin: null, token: 't', port: 6780, metricsPort: 1 })
    ).toThrow(/not installed/);
  });
});
