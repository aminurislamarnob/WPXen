import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import remoteAccess, { HOST_ID_KEY } from '../electron/services/remoteAccess.cjs';

// Push notifications for Session alerts (#149): approved alerts fan out to
// eligible devices through Expo's push API. fetch, store, clock and the log
// sink arrive through `__setDeps`; no agents engine needed because gating
// happens before the service ever sees an alert.

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';

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

let store;
let posts;
let fetchHandler;
let logs;

const DEVICE_KEY = 'wpxenRemoteDevices';

function device(over = {}) {
  return {
    id: 'device-1',
    name: 'Phone',
    platform: 'ios',
    publicKey: 'a2V5',
    pairedAt: 1,
    lastSeen: 1,
    pushToken: 'ExponentPushToken[aaaa]',
    pushEnabled: true,
    ...over,
  };
}

beforeEach(() => {
  store = fakeStore({ [HOST_ID_KEY]: 'test-host-id' });
  posts = [];
  logs = [];
  fetchHandler = async () => ({
    ok: true,
    json: async () => ({ data: [{ status: 'ok' }] }),
  });
  remoteAccess.__setDeps({
    store,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
      decryptString: (cipher) =>
        Buffer.from(cipher.toString('utf8').replace(/^enc:/, ''), 'utf8'),
    },
    randomId: () => 'test-id',
    now: () => Date.now(),
    log: (message) => logs.push(String(message)),
    fetch: async (url, opts) => {
      if (String(url) !== EXPO_URL) return fetchHandler(url, opts);
      posts.push(JSON.parse(opts.body));
      return fetchHandler(url, opts);
    },
    getRemoteConfig: () => ({ enabled: true, port: 6780, hostname: 'wpxen.example.com' }),
  });
});

afterEach(() => {
  remoteAccess.dispose();
});

describe('session alert push', () => {
  it('sends one generic push per eligible device for every approved alert', async () => {
    store.set(DEVICE_KEY, [
      device(),
      device({ id: 'device-2', pushToken: 'ExponentPushToken[bbbb]' }),
    ]);
    for (const [kind, body] of [
      ['needs-input', 'A Session needs your input'],
      ['done', 'A Session finished'],
      ['error', 'A Session exited with an error'],
    ]) {
      posts.length = 0;
      await remoteAccess.handleSessionAlert({ kind, sessionId: 's1' });
      expect(posts).toHaveLength(1);
      expect(posts[0]).toHaveLength(2);
      expect(posts[0][0]).toMatchObject({ title: 'WPXen', body });
      expect(Object.keys(posts[0][0].data).sort()).toEqual(['hostId', 'sessionId']);
      expect(posts[0][0].data).toEqual({ hostId: 'test-host-id', sessionId: 's1' });
    }
  });

  it('reads a terminal bell as needs-input', async () => {
    store.set(DEVICE_KEY, [device()]);
    await remoteAccess.handleSessionAlert({ kind: 'bell', sessionId: 's1' });
    expect(posts[0][0].body).toBe('A Session needs your input');
  });

  it('sends nothing to revoked, disabled or tokenless devices', async () => {
    store.set(DEVICE_KEY, [
      device({ id: 'revoked' }),
      device({ id: 'off', pushEnabled: false }),
      device({ id: 'bare', pushToken: null }),
    ]);
    await remoteAccess.revokeDevice('revoked');
    await remoteAccess.handleSessionAlert({ kind: 'done', sessionId: 's1' });
    expect(posts).toHaveLength(0);
  });

  it('clears DeviceNotRegistered tokens and never logs a token', async () => {
    store.set(DEVICE_KEY, [
      device(),
      device({ id: 'device-2', pushToken: 'ExponentPushToken[dead]' }),
    ]);
    fetchHandler = async () => ({
      ok: true,
      json: async () => ({
        data: [
          { status: 'ok' },
          {
            status: 'error',
            message: '"DeviceNotRegistered"',
            details: { error: 'DeviceNotRegistered' },
          },
        ],
      }),
    });
    await remoteAccess.handleSessionAlert({ kind: 'done', sessionId: 's1' });
    const kept = store.get(DEVICE_KEY, []);
    expect(kept.find((d) => d.id === 'device-1').pushToken).toBe(
      'ExponentPushToken[aaaa]'
    );
    expect(kept.find((d) => d.id === 'device-2').pushToken).toBeNull();
    expect(JSON.stringify(logs)).not.toContain('ExponentPushToken');
  });

  it('logs failures without retrying in a loop', async () => {
    store.set(DEVICE_KEY, [device()]);
    let calls = 0;
    fetchHandler = async () => {
      calls += 1;
      throw new Error('network down');
    };
    await remoteAccess.handleSessionAlert({ kind: 'done', sessionId: 's1' });
    expect(calls).toBe(1);
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain('ExponentPushToken');
  });
});

describe('device push ops', () => {
  it('registers, updates and clears the calling devices own token', async () => {
    store.set(DEVICE_KEY, [device({ pushToken: null })]);
    // The ops resolve the device from the connection; the service layer
    // takes the id the channel authenticated.
    expect(
      await remoteAccess.setDevicePushToken('device-1', 'ExponentPushToken[new]')
    ).toEqual({ ok: true });
    expect(store.get(DEVICE_KEY, [])[0].pushToken).toBe('ExponentPushToken[new]');
    expect(await remoteAccess.setDevicePushToken('device-1', null)).toEqual({ ok: true });
    expect(store.get(DEVICE_KEY, [])[0].pushToken).toBeNull();
    await expect(remoteAccess.setDevicePushToken('nope', 'x')).rejects.toThrow();
  });

  it('toggles push per device and reports push state', async () => {
    store.set(DEVICE_KEY, [device()]);
    expect(await remoteAccess.setDevicePushEnabled('device-1', false)).toEqual({
      ok: true,
    });
    expect(await remoteAccess.devicePushState('device-1')).toEqual({
      hasToken: true,
      pushEnabled: false,
    });
    await expect(remoteAccess.setDevicePushEnabled('device-1', 'yes')).rejects.toThrow();
    await expect(remoteAccess.devicePushState('nope')).rejects.toThrow();
  });
});
