import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import agents from '../electron/services/agents.cjs';
import remoteAccess, { HOST_ID_KEY } from '../electron/services/remoteAccess.cjs';
import {
  PROTOCOL_VERSION,
  newKeyPair,
  parsePairingUrl,
  createPairRequest,
  openPairAccept,
  createClient,
  decodeBase64,
} from '../shared/remote-protocol/index.cjs';

// Live Session terminal over the encrypted channel (#146): the real server on
// 127.0.0.1:0, the real client half, and the real Session engine with a fake
// pty. Output batching runs on an injected timer so tests control the flush.

const HOSTNAME = 'wpxen.example.com';

function fakePty() {
  const handlers = { data: [], exit: [] };
  return {
    onData: (cb) => handlers.data.push(cb),
    onExit: (cb) => handlers.exit.push(cb),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    emitData: (d) => handlers.data.forEach((cb) => cb(d)),
    emitExit: (code) => handlers.exit.forEach((cb) => cb({ exitCode: code })),
  };
}

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

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (cipher) =>
      Buffer.from(cipher.toString('utf8').replace(/^enc:/, ''), 'utf8'),
  };
}

// Controllable timers for output batching: callbacks queue until flushed.
function fakeTimers() {
  const queue = new Map();
  let nextId = 1;
  return {
    queue,
    timers: {
      setTimeout: (fn) => {
        const id = nextId++;
        queue.set(id, fn);
        return id;
      },
      clearTimeout: (id) => {
        queue.delete(id);
      },
    },
    flush() {
      const fns = [...queue.values()];
      queue.clear();
      fns.forEach((fn) => fn());
    },
    pending() {
      return queue.size;
    },
  };
}

let home;
let ptys;
let store;
let timers;

function wsUrl(port) {
  return `ws://127.0.0.1:${port}/wpxen-device`;
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-ra-terminal-'));
  fs.mkdirSync(path.join(home, 'code'));
  ptys = [];
  agents.__setDeps({
    spawnPty: (file, args, opts) => {
      const p = fakePty();
      p.spawnedWith = { file, args, opts };
      ptys.push(p);
      return p;
    },
    shellEnv: () => ({ PATH: '/usr/bin' }),
    userShell: () => '/bin/zsh',
    homedir: () => home,
  });
  store = fakeStore({ [HOST_ID_KEY]: 'test-host-id' });
  timers = fakeTimers();
  remoteAccess.__setDeps({
    store,
    safeStorage: fakeSafeStorage(),
    randomId: () => 'test-id',
    now: () => Date.now(),
    pairTimeoutMs: 500,
    promptPairing: async () => 'allow',
    onPaired: () => {},
    getRemoteConfig: () => ({ enabled: true, port: 6780, hostname: HOSTNAME }),
    timers: timers.timers,
    sessions: {
      list: agents.listAllSessions,
      subscribe: agents.onSessionsChanged,
      markRead: (id, read) => agents.markRead(id, read),
      get: (id) => agents.getSession(id),
      projects: () => [{ id: 'shop', name: 'Shop', kind: 'site' }],
      subscribeOutput: (id, sinks) => agents.subscribeOutput(id, sinks),
      write: (id, data) => agents.write(id, data),
      resize: (id, cols, rows) => agents.resize(id, cols, rows),
    },
  });
  remoteAccess.start({ port: 0 });
  const start = Date.now();
  while (remoteAccess.getStatus().state !== 'listening') {
    if (Date.now() - start > 5000) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 10));
  }
});

afterEach(() => {
  remoteAccess.dispose();
  agents.stopAll();
  fs.rmSync(home, { recursive: true, force: true });
});

const site = () => ({ id: 'shop', name: 'Shop', path: path.join(home, 'code') });

async function pairedPhone() {
  const port = remoteAccess.getStatus().actualPort;
  const keys = newKeyPair();
  const offer = await remoteAccess.pairingOffer({ hostname: HOSTNAME });
  const parsed = parsePairingUrl(offer.url);
  const hostPublicKey = decodeBase64(parsed.hostPublicKeyB64);
  const { message } = createPairRequest({
    secret: parsed.secret,
    deviceName: 'Phone',
    platform: 'ios',
    keys,
    hostPublicKey,
    version: PROTOCOL_VERSION,
  });
  const socket = new WebSocket(wsUrl(port));
  await new Promise((resolve, reject) => {
    socket.on('open', resolve);
    socket.on('error', reject);
  });
  const reply = await new Promise((resolve) => {
    socket.on('message', (data) => resolve(JSON.parse(data.toString())));
    socket.send(JSON.stringify(message));
  });
  const { deviceId } = openPairAccept({ message: reply, keys, hostPublicKey });
  socket.close();
  const client = createClient({
    url: wsUrl(port),
    WebSocket,
    keys,
    hostPublicKey,
    deviceId,
  });
  await client.connect();
  await client.request('ping');
  return { client, keys, hostPublicKey, deviceId, port };
}

function collectTerminal(client) {
  const events = { replay: [], data: [], exit: [] };
  const offs = [
    client.subscribe('terminal.replay', (payload) => events.replay.push(payload)),
    client.subscribe('terminal.data', (payload) => events.data.push(payload)),
    client.subscribe('terminal.exit', (payload) => events.exit.push(payload)),
  ];
  return {
    events,
    stop: () => offs.forEach((off) => off()),
  };
}

async function waitFor(fn, message, timeout = 3000) {
  const start = Date.now();
  for (;;) {
    try {
      return fn();
    } catch {
      if (Date.now() - start > timeout) throw new Error(message);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

describe('terminal over the channel', () => {
  it('attaches with replay, then live data, then exit, in order', async () => {
    const { sessionId } = agents.launch({ site: site(), agentId: agents.SHELL_ID });
    ptys[0].emitData('before-attach\n');
    const { client } = await pairedPhone();
    const terminal = collectTerminal(client);

    expect(await client.request('terminal.attach', { sessionId })).toEqual({ ok: true });
    await waitFor(() => {
      expect(terminal.events.replay).toHaveLength(1);
    }, 'no replay arrived');
    expect(terminal.events.replay[0]).toMatchObject({
      sessionId,
      data: 'before-attach\n',
      exited: false,
    });

    ptys[0].emitData('live one\n');
    ptys[0].emitData('live two\n');
    timers.flush();
    await waitFor(() => {
      expect(terminal.events.data.length).toBeGreaterThanOrEqual(1);
    }, 'no data arrived');
    expect(terminal.events.data.map((e) => e.data).join('')).toBe('live one\nlive two\n');

    ptys[0].emitExit(0);
    await waitFor(() => {
      expect(terminal.events.exit).toHaveLength(1);
    }, 'no exit arrived');
    expect(terminal.events.exit[0]).toMatchObject({ sessionId, code: 0 });
    // Replay came before any live chunk, and the exit closed the stream.
    expect(terminal.events.replay).toHaveLength(1);
    terminal.stop();
    client.close();
  });

  it('rejects attach, detach and write for unknown Sessions', async () => {
    const { client } = await pairedPhone();
    await expect(
      client.request('terminal.attach', { sessionId: 'nope' })
    ).rejects.toThrow();
    await expect(
      client.request('terminal.detach', { sessionId: 'nope' })
    ).rejects.toThrow();
    await expect(
      client.request('terminal.write', { sessionId: 'nope', data: 'x' })
    ).rejects.toThrow();
    client.close();
  });

  it('gives the desktop window and the phone the same stream at once', async () => {
    const { sessionId } = agents.launch({ site: site(), agentId: agents.SHELL_ID });
    const desktop = { replay: [], data: [], exit: [] };
    agents.subscribeOutput(sessionId, {
      onReplay: (replay) => desktop.replay.push(replay),
      onData: (data) => desktop.data.push(data),
      onExit: (code) => desktop.exit.push(code),
    });
    const { client } = await pairedPhone();
    const terminal = collectTerminal(client);
    await client.request('terminal.attach', { sessionId });

    ptys[0].emitData('same stream\n');
    timers.flush();
    ptys[0].emitExit(3);

    await waitFor(() => {
      expect(terminal.events.data.length).toBeGreaterThanOrEqual(1);
      expect(terminal.events.exit).toHaveLength(1);
    }, 'phone stream incomplete');
    expect(desktop.data.join('')).toBe('same stream\n');
    expect(terminal.events.data.map((e) => e.data).join('')).toBe('same stream\n');
    expect(desktop.exit).toEqual([3]);
    expect(terminal.events.exit[0]).toMatchObject({ sessionId, code: 3 });
    terminal.stop();
    client.close();
  });

  it('re-attaching replaces the subscription instead of duplicating it', async () => {
    const { sessionId } = agents.launch({ site: site(), agentId: agents.SHELL_ID });
    const { client } = await pairedPhone();
    const terminal = collectTerminal(client);
    await client.request('terminal.attach', { sessionId });
    await client.request('terminal.attach', { sessionId });
    terminal.events.replay.length = 0;
    terminal.events.data.length = 0;

    ptys[0].emitData('once\n');
    timers.flush();
    await waitFor(() => {
      expect(terminal.events.data.length).toBeGreaterThanOrEqual(1);
    }, 'no data arrived');
    expect(terminal.events.data).toHaveLength(1);
    expect(terminal.events.data[0].data).toBe('once\n');
    terminal.stop();
    client.close();
  });

  it('detach unsubscribes without stopping the Session', async () => {
    const { sessionId } = agents.launch({ site: site(), agentId: agents.SHELL_ID });
    const { client } = await pairedPhone();
    const terminal = collectTerminal(client);
    await client.request('terminal.attach', { sessionId });
    expect(await client.request('terminal.detach', { sessionId })).toEqual({ ok: true });
    terminal.events.data.length = 0;

    ptys[0].emitData('after detach\n');
    timers.flush();
    await new Promise((r) => setTimeout(r, 200));
    expect(terminal.events.data).toHaveLength(0);
    expect(agents.getSession(sessionId)).not.toBeNull();
    terminal.stop();
    client.close();
  });

  it('closing the socket detaches everything but keeps the Session alive', async () => {
    const { sessionId } = agents.launch({ site: site(), agentId: agents.SHELL_ID });
    const { client, keys, hostPublicKey, deviceId, port } = await pairedPhone();
    await client.request('terminal.attach', { sessionId });
    client.close();
    await new Promise((r) => setTimeout(r, 200));

    ptys[0].emitData('after close\n');
    expect(agents.getSession(sessionId)).not.toBeNull();

    // Reconnecting re-attaches cleanly and replays the buffer.
    const next = createClient({
      url: wsUrl(port),
      WebSocket,
      keys,
      hostPublicKey,
      deviceId,
    });
    const terminal = collectTerminal(next);
    await next.connect();
    await next.request('ping');
    await next.request('terminal.attach', { sessionId });
    await waitFor(() => {
      expect(terminal.events.replay).toHaveLength(1);
    }, 'no replay after reconnect');
    expect(terminal.events.replay[0].data).toContain('after close\n');
    terminal.stop();
    next.close();
  });

  it('writes input byte-for-byte, rejects oversized frames, ignores exited Sessions', async () => {
    const { sessionId } = agents.launch({ site: site(), agentId: agents.SHELL_ID });
    const { client } = await pairedPhone();
    await client.request('terminal.attach', { sessionId });

    const input = 'echo hello \x1b[34mworld\x1b[0m\r';
    expect(await client.request('terminal.write', { sessionId, data: input })).toEqual({
      ok: true,
    });
    expect(ptys[0].write).toHaveBeenCalledWith(input);

    await expect(
      client.request('terminal.write', { sessionId, data: 'x'.repeat(65537) })
    ).rejects.toThrow(/too large/i);

    ptys[0].emitExit(0);
    const calls = ptys[0].write.mock.calls.length;
    expect(
      await client.request('terminal.write', { sessionId, data: 'after exit' })
    ).toEqual({
      ok: true,
    });
    expect(ptys[0].write.mock.calls.length).toBe(calls);
    client.close();
  });

  it('batches many small pty chunks into few frames without losing bytes', async () => {
    const { sessionId } = agents.launch({ site: site(), agentId: agents.SHELL_ID });
    const { client } = await pairedPhone();
    const terminal = collectTerminal(client);
    await client.request('terminal.attach', { sessionId });
    terminal.events.data.length = 0;

    const chunks = Array.from({ length: 50 }, (_, i) => `c${i};`);
    for (const chunk of chunks) ptys[0].emitData(chunk);
    // Nothing goes out before the batch window flushes.
    expect(terminal.events.data).toHaveLength(0);
    timers.flush();
    await waitFor(() => {
      expect(terminal.events.data.length).toBeGreaterThanOrEqual(1);
    }, 'no batched data arrived');
    expect(terminal.events.data.length).toBeLessThanOrEqual(3);
    expect(terminal.events.data.map((e) => e.data).join('')).toBe(chunks.join(''));
    terminal.stop();
    client.close();
  });
});

describe('terminal size ownership', () => {
  it('resizes the pty from the phone and rejects bad values', async () => {
    const { sessionId } = agents.launch({ site: site(), agentId: agents.SHELL_ID });
    const { client } = await pairedPhone();

    expect(
      await client.request('terminal.resize', { sessionId, cols: 40, rows: 10 })
    ).toEqual({
      ok: true,
    });
    expect(ptys[0].resize).toHaveBeenCalledWith(40, 10);

    for (const bad of [
      { sessionId, cols: 0, rows: 10 },
      { sessionId, cols: 40, rows: -1 },
      { sessionId, cols: 1.5, rows: 10 },
      { sessionId, cols: 40, rows: 501 },
      { sessionId, cols: '40', rows: 10 },
    ]) {
      await expect(client.request('terminal.resize', bad)).rejects.toThrow();
    }
    await expect(
      client.request('terminal.resize', { sessionId: 'nope', cols: 40, rows: 10 })
    ).rejects.toThrow();
    client.close();
  });

  it('a phone resize followed by a desktop re-assert restores the desktop size', async () => {
    const { sessionId } = agents.launch({ site: site(), agentId: agents.SHELL_ID });
    const { client } = await pairedPhone();

    await client.request('terminal.resize', { sessionId, cols: 40, rows: 10 });
    expect(ptys[0].resize).toHaveBeenLastCalledWith(40, 10);

    // What the desktop focus listener sends through the same engine path.
    agents.resize(sessionId, 80, 24);
    expect(ptys[0].resize).toHaveBeenLastCalledWith(80, 24);
    client.close();
  });
});
