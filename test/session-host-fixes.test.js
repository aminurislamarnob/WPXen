import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createSessionHost } from '../electron/services/sessionHost.cjs';
import { createSessionHostClient } from '../electron/services/sessionHostClient.cjs';
import {
  appendHistory,
  historyFilePath,
  readHistory,
} from '../electron/services/sessionHistory.cjs';

// Regression tests for the Session Host review fixes: framing, timeouts,
// socket ownership, lifecycle and history.

const until = async (fn, timeout = 5000) => {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeout) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

function fakePtyFactory(ptys) {
  let nextPid = 5000;
  return () => {
    const handlers = { data: [], exit: [] };
    const p = {
      pid: (nextPid += 10),
      onData: (cb) => handlers.data.push(cb),
      onExit: (cb) => handlers.exit.push(cb),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      emitData: (d) => handlers.data.forEach((cb) => cb(d)),
      emitExit: (code) => handlers.exit.forEach((cb) => cb({ exitCode: code })),
    };
    ptys.push(p);
    return p;
  };
}

// A bare server that tracks its connections so a test can tear them down.
function rawServer(onConn) {
  const conns = new Set();
  const server = net.createServer((conn) => {
    conns.add(conn);
    conn.resume();
    onConn(conn);
  });
  server.shut = () =>
    new Promise((r) => {
      for (const c of conns) c.destroy();
      server.close(r);
    });
  return server;
}

let tmp;
let sockPath;
let histDir;
let ptys;
let hosts;
let clients;

function makeHost(opts = {}) {
  const host = createSessionHost({
    socketPath: sockPath,
    appVersion: '0.6.4',
    historyDir: histDir,
    spawnPty: fakePtyFactory(ptys),
    ...opts,
  });
  hosts.push(host);
  return host;
}

function makeClient(opts = {}) {
  const c = createSessionHostClient({ socketPath: sockPath, ...opts });
  clients.push(c);
  return c;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-fixes-'));
  sockPath = path.join(tmp, 'h.sock');
  histDir = path.join(tmp, 'history');
  ptys = [];
  hosts = [];
  clients = [];
});

afterEach(async () => {
  for (const c of clients) await c.close().catch(() => {});
  for (const h of hosts) await h.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('framing', () => {
  it('keeps a multibyte character whole when a socket read splits it (client side)', async () => {
    const line = Buffer.from(
      JSON.stringify({ v: 1, type: 'output', sessionId: 's', data: '€ ─│ ✳' }) + '\n'
    );
    const cut = line.indexOf(Buffer.from('€')) + 1; // inside the 3-byte €
    const server = rawServer((conn) => {
      conn.write(line.subarray(0, cut));
      setTimeout(() => conn.write(line.subarray(cut)), 20);
    });
    await new Promise((r) => server.listen(sockPath, r));
    const client = makeClient();
    const outputs = [];
    client.onOutput((e) => outputs.push(e.data));
    try {
      // Any request opens the connection; the reply never comes, so don't wait.
      client.list().catch(() => {});
      await until(() => outputs.length === 1);
      expect(outputs[0]).toBe('€ ─│ ✳');
    } finally {
      await server.shut();
      await client.close();
    }
  });

  it('keeps a multibyte character whole when a socket read splits it (host side)', async () => {
    await makeHost().start();
    const client = makeClient();
    await client.start({ sessionId: 's-1', file: '/bin/zsh' });
    const raw = net.connect(sockPath);
    await new Promise((r) => raw.once('connect', r));
    const line = Buffer.from(
      JSON.stringify({ v: 1, id: 1, type: 'write', sessionId: 's-1', data: 'é€' }) + '\n'
    );
    const cut = line.indexOf(Buffer.from('€')) + 2;
    raw.write(line.subarray(0, cut));
    await new Promise((r) => setTimeout(r, 20));
    raw.write(line.subarray(cut));
    await until(() => ptys[0].write.mock.calls.length === 1);
    expect(ptys[0].write).toHaveBeenCalledWith('é€');
    raw.destroy();
  });

  it('replays a full 5 MB escape-dense history on attach (JSON line over 8 MB)', async () => {
    await makeHost().start();
    const client = makeClient();
    await client.start({ sessionId: 's-big', file: '/bin/zsh' });
    const chunk = '\x1b[2K\x1b[1A'.repeat(1024); // 8 KB raw, ~14 KB as JSON
    let written = 0;
    while (written < 4.9 * 1024 * 1024) {
      appendHistory(histDir, 's-big', chunk);
      written += chunk.length;
    }
    const expected = readHistory(histDir, 's-big');
    expect(JSON.stringify(expected).length).toBeGreaterThan(8 * 1024 * 1024);
    const snap = await client.attach('s-big');
    expect(snap.data.length).toBe(expected.length);
  }, 20000);
});

describe('timeouts', () => {
  it('rejects a request the host never answers instead of waiting for ever', async () => {
    const server = rawServer(() => {}); // accepts, never replies
    await new Promise((r) => server.listen(sockPath, r));
    const client = makeClient({ requestTimeoutMs: 50, helloTimeoutMs: 50 });
    try {
      await expect(client.list()).rejects.toThrow(/did not answer/);
      await expect(client.hello()).rejects.toThrow(/did not answer/);
    } finally {
      await server.shut();
      await client.close();
    }
  });
});

describe('socket ownership', () => {
  it('a second host refuses a socket a live host is listening on', async () => {
    await makeHost().start();
    const first = makeClient();
    await first.start({ sessionId: 's-keep', file: '/bin/zsh' });

    await expect(makeHost().start()).rejects.toThrow(/already listening/);

    const again = makeClient();
    const listed = await again.list();
    expect(listed.map((s) => s.sessionId)).toEqual(['s-keep']);
  });

  it('replaces a stale socket path nobody answers on', async () => {
    fs.writeFileSync(sockPath, 'stale');
    await makeHost().start();
    const client = makeClient();
    expect((await client.hello()).appVersion).toBe('0.6.4');
  });
});

describe('lifecycle', () => {
  it('exits when its only client leaves, even if it never held a Session', async () => {
    let exited = 0;
    await makeHost({ onExit: () => exited++ }).start();
    const client = makeClient();
    await client.hello();
    await client.close();
    await until(() => exited === 1);
  });

  it('exits after the startup grace when no client ever connects', async () => {
    let exited = 0;
    await makeHost({ startupGraceMs: 30, onExit: () => exited++ }).start();
    await until(() => exited === 1);
  });

  it('stays up until a stopped Session’s process has exited, so SIGKILL can still run', async () => {
    let exited = 0;
    await makeHost({ killGraceMs: 60_000, onExit: () => exited++ }).start();
    const client = makeClient();
    await client.start({ sessionId: 's-1', file: '/bin/zsh' });
    await client.stop('s-1');
    await client.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(exited).toBe(0);
    ptys[0].emitExit(0);
    await until(() => exited === 1);
  });
});

describe('history on stop', () => {
  it('keeps history for a Session stopped with keepHistory, deletes it otherwise', async () => {
    await makeHost().start();
    const client = makeClient();
    await client.hello();
    await client.start({ sessionId: 'kept', file: '/bin/zsh' });
    await client.start({ sessionId: 'closed', file: '/bin/zsh' });
    ptys[0].emitData('kept output\r\n');
    ptys[1].emitData('closed output\r\n');

    await client.stop('kept', { keepHistory: true });
    await client.stop('closed');
    expect(readHistory(histDir, 'kept')).toBe('kept output\r\n');
    expect(fs.existsSync(historyFilePath(histDir, 'closed'))).toBe(false);

    // Output printed during the grace period must not recreate the file.
    ptys[1].emitData('late output\r\n');
    expect(fs.existsSync(historyFilePath(histDir, 'closed'))).toBe(false);
  });

  it('keeps a Session running when its history cannot be written', async () => {
    fs.writeFileSync(histDir, 'not a folder'); // mkdir fails with ENOTDIR
    await makeHost().start();
    const client = makeClient();
    const outputs = [];
    client.onOutput((e) => outputs.push(e.data));
    await client.start({ sessionId: 's-1', file: '/bin/zsh' });
    expect(() => ptys[0].emitData('still here')).not.toThrow();
    await until(() => outputs.length === 1);
    expect((await client.list())[0]).toMatchObject({ sessionId: 's-1', exited: false });
  });
});
