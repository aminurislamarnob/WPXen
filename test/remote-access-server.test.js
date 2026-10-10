import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import remoteAccess, {
  HOST_ID_KEY,
  DEFAULT_PORT,
} from '../electron/services/remoteAccess.cjs';
import { PROTOCOL_VERSION, HEALTH_PATH } from '../shared/remote-protocol/index.cjs';

// Remote Access tracer (#140): a localhost HTTP server with a health route,
// driven over real HTTP on an ephemeral port. The store is fake; the socket
// is real.

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

beforeEach(() => {
  store = fakeStore();
  remoteAccess.__setDeps({ store, randomId: () => 'test-host-id' });
});

afterEach(() => {
  remoteAccess.dispose();
});

function waitForState(state, timeout = 3000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const status = remoteAccess.getStatus();
      if (status.state === state) return resolve(status);
      if (Date.now() - start > timeout) {
        return reject(
          new Error(`timed out waiting for ${state}: ${JSON.stringify(status)}`)
        );
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

async function startEphemeral() {
  remoteAccess.start({ port: 0 });
  return waitForState('listening');
}

describe('remoteAccess server', () => {
  it('is off on a fresh install, with no port open', () => {
    expect(remoteAccess.getStatus()).toMatchObject({ state: 'off', actualPort: null });
    expect(DEFAULT_PORT).toBe(6780);
  });

  it('listens on 127.0.0.1 only', async () => {
    const status = await startEphemeral();
    expect(status.host).toBe('127.0.0.1');
    expect(status.actualPort).toBeGreaterThan(0);

    // Reachable on loopback…
    const ok = await fetch(`http://127.0.0.1:${status.actualPort}${HEALTH_PATH}?nonce=x`);
    expect(ok.status).toBe(200);

    // …but on nothing else. A non-loopback interface address must refuse.
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i?.family === 'IPv4' && !i.internal)?.address;
    if (!external) return;
    await expect(
      fetch(`http://${external}:${status.actualPort}${HEALTH_PATH}?nonce=x`)
    ).rejects.toThrow();
  });

  it('echoes the nonce, a stable host identity and the protocol version', async () => {
    const first = await startEphemeral();
    const res = await fetch(
      `http://127.0.0.1:${first.actualPort}${HEALTH_PATH}?nonce=abc123`
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      nonce: 'abc123',
      hostId: 'test-host-id',
      protocolVersion: PROTOCOL_VERSION,
    });

    // The identity survives a restart: it lives in the store, not memory.
    remoteAccess.stop();
    await waitForState('off');
    const second = await startEphemeral();
    const again = await fetch(
      `http://127.0.0.1:${second.actualPort}${HEALTH_PATH}?nonce=zzz`
    );
    expect(await again.json()).toMatchObject({ hostId: 'test-host-id' });
  });

  it('stores the host identity under a wpxen-prefixed key', async () => {
    expect(HOST_ID_KEY.startsWith('wpxen')).toBe(true);
    await startEphemeral();
    await fetch(`http://127.0.0.1:${remoteAccess.getStatus().actualPort}${HEALTH_PATH}`);
    expect(store.data[HOST_ID_KEY]).toBe('test-host-id');
  });

  it('returns 404 for every other path', async () => {
    const { actualPort } = await startEphemeral();
    for (const path of ['/', '/nope', '/wpxen-health/extra']) {
      const res = await fetch(`http://127.0.0.1:${actualPort}${path}`);
      expect(res.status, path).toBe(404);
    }
  });

  it('refuses WebSocket upgrades', async () => {
    const { actualPort } = await startEphemeral();
    const seen = await new Promise((resolve, reject) => {
      const socket = net.connect(actualPort, '127.0.0.1', () => {
        socket.write(
          'GET / HTTP/1.1\r\n' +
            'Host: 127.0.0.1\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
            'Sec-WebSocket-Version: 13\r\n\r\n'
        );
      });
      let data = '';
      socket.on('data', (chunk) => (data += chunk.toString()));
      socket.on('close', () => resolve(data));
      socket.on('error', () => resolve(data));
      setTimeout(() => reject(new Error('upgrade socket never closed')), 3000);
    });
    expect(seen).not.toMatch(/101/);
  });

  it('closing stops the server and the port goes quiet', async () => {
    const { actualPort } = await startEphemeral();
    remoteAccess.stop();
    await waitForState('off');
    await expect(fetch(`http://127.0.0.1:${actualPort}${HEALTH_PATH}`)).rejects.toThrow();
  });

  it('reports a clear error when the port is in use', async () => {
    const squatter = net.createServer();
    await new Promise((resolve) => squatter.listen(0, '127.0.0.1', resolve));
    const taken = squatter.address().port;
    try {
      remoteAccess.start({ port: taken });
      const status = await waitForState('error');
      expect(status.reason).toBe(`Port ${taken} is in use`);
    } finally {
      squatter.close();
    }
  });

  it('moving to a new port restarts the server there', async () => {
    const first = await startEphemeral();
    const oldPort = first.actualPort;

    remoteAccess.start({ port: 0 });
    const start = Date.now();
    let second = remoteAccess.getStatus();
    while (
      !(second.state === 'listening' && second.actualPort !== oldPort) &&
      Date.now() - start < 3000
    ) {
      await new Promise((r) => setTimeout(r, 10));
      second = remoteAccess.getStatus();
    }
    expect(second.state).toBe('listening');
    expect(second.actualPort).not.toBe(oldPort);

    const res = await fetch(
      `http://127.0.0.1:${second.actualPort}${HEALTH_PATH}?nonce=moved`
    );
    expect(res.status).toBe(200);
    await expect(fetch(`http://127.0.0.1:${oldPort}${HEALTH_PATH}`)).rejects.toThrow();
  });

  it('rejects invalid ports without touching the server', () => {
    for (const port of [80, 70000, 1.5, '6780', NaN]) {
      expect(() => remoteAccess.start({ port })).toThrow();
    }
    expect(remoteAccess.getStatus().state).toBe('off');
  });

  it('pushes status changes and isolates a throwing listener', async () => {
    const seen = [];
    const off = remoteAccess.onStatusChange((s) => seen.push(s.state));
    const bad = remoteAccess.onStatusChange(() => {
      throw new Error('listener boom');
    });

    remoteAccess.start({ port: 0 });
    await waitForState('listening');
    remoteAccess.stop();
    await waitForState('off');

    expect(seen).toContain('listening');
    expect(seen.at(-1)).toBe('off');
    off();
    bad();
  });
});
