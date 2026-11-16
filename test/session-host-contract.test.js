import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createSessionHost } from '../electron/services/sessionHost.cjs';
import { createSessionHostClient } from '../electron/services/sessionHostClient.cjs';

// The additive-only guard (#230, #235). The fixture records what protocol v1
// put on the wire. A newer app must keep understanding an older host's replies
// and events, and a newer host must keep answering an older app's requests
// with every field it once sent. Renaming or removing a field fails here.

const FIXTURE = path.join(__dirname, 'fixtures', 'session-host-protocol-v1.jsonl');
const entries = fs
  .readFileSync(FIXTURE, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
const clientMsgs = entries.filter((e) => e.direction === 'client').map((e) => e.message);
const hostMsgs = entries.filter((e) => e.direction === 'host').map((e) => e.message);
const replyById = new Map(hostMsgs.filter((m) => m.id != null).map((m) => [m.id, m]));
const requestFor = (type) => clientMsgs.find((m) => m.type === type);
const recordedReply = (type) => replyById.get(requestFor(type).id);
const recordedEvent = (type) => hostMsgs.find((m) => m.type === type);

// Every field of `recorded` is present in `actual` with the same JSON type.
// A recorded null only requires the field to exist.
function expectShape(recorded, actual, where) {
  if (recorded === null) return;
  if (Array.isArray(recorded)) {
    expect(Array.isArray(actual), `${where} should be an array`).toBe(true);
    if (recorded.length > 0) {
      expect(actual.length, `${where} should not be empty`).toBeGreaterThan(0);
      expectShape(recorded[0], actual[0], `${where}[0]`);
    }
    return;
  }
  if (typeof recorded === 'object') {
    expect(actual && typeof actual === 'object', `${where} should be an object`).toBe(
      true
    );
    for (const key of Object.keys(recorded)) {
      expect(key in actual, `${where}.${key} is missing`).toBe(true);
      expectShape(recorded[key], actual[key], `${where}.${key}`);
    }
    return;
  }
  expect(typeof actual, `${where} changed type`).toBe(typeof recorded);
}

// `msg` minus the envelope keys, the way the client hands it to callers.
const without = (msg, ...keys) =>
  Object.fromEntries(Object.entries(msg).filter(([k]) => !keys.includes(k)));

const until = async (fn, timeout = 3000) => {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeout) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-contract-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('protocol v1 contract: the current host', () => {
  it('answers every recorded request with every recorded reply field', async () => {
    const sockPath = path.join(tmp, 'h.sock');
    const host = createSessionHost({
      socketPath: sockPath,
      appVersion: '9.9.9',
      historyDir: path.join(tmp, 'history'),
      spawnPty: () => ({
        pid: 4242,
        onData: () => {},
        onExit: () => {},
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      }),
    });
    await host.start();
    const sock = net.connect(sockPath);
    const replies = new Map();
    let buf = '';
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (msg.id != null) replies.set(msg.id, msg);
      }
    });
    try {
      for (const req of clientMsgs) {
        sock.write(JSON.stringify(req) + '\n');
        await until(() => replies.has(req.id));
        const recorded = replyById.get(req.id);
        expect(replies.get(req.id).ok, `${req.type} failed`).toBe(recorded.ok);
        expectShape(recorded, replies.get(req.id), `${req.type} reply`);
      }
      sock.write(JSON.stringify({ v: 1, id: 99, type: 'bogus' }) + '\n');
      await until(() => replies.has(99));
      expectShape(replyById.get(99), replies.get(99), 'error reply');
    } finally {
      sock.destroy();
      await host.close();
    }
  });
});

describe('protocol v1 contract: the current client', () => {
  it('understands every recorded reply and event from a v1 host', async () => {
    const sockPath = path.join(tmp, 'old-host.sock');
    const received = [];
    let peer = null;
    const server = net.createServer((conn) => {
      peer = conn;
      let buf = '';
      conn.on('data', (c) => {
        buf += c.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
          const req = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          received.push(req);
          const reply = recordedReply(req.type);
          conn.write(JSON.stringify({ ...reply, id: req.id }) + '\n');
        }
      });
    });
    await new Promise((r) => server.listen(sockPath, r));
    const client = createSessionHostClient({ socketPath: sockPath });
    try {
      const hello = await client.hello();
      expect(hello.appVersion).toBe(recordedReply('hello').appVersion);
      expect(client.supports('mark-read')).toBe(true);
      expect(client.supports('stop-keep-history')).toBe(true);

      const started = await client.start({
        sessionId: 's-1',
        file: '/bin/zsh',
        args: ['-il'],
        cwd: '/tmp',
        env: { TERM: 'xterm-256color' },
      });
      expect(started).toEqual({ sessionId: 's-1', pid: recordedReply('start').pid });
      expect(client.getPid('s-1')).toBe(recordedReply('start').pid);

      const listed = await client.list();
      expect(listed).toEqual(recordedReply('list').sessions);

      const attachFields = without(recordedReply('attach'), 'v', 'id', 'ok');
      expect(await client.attach('s-1')).toEqual(attachFields);

      await client.write('s-1', 'ls\r');
      await client.resize('s-1', 120, 40);
      await client.markRead('s-1', true);
      await client.clearBuffer('s-1');
      await client.stop('s-1', { keepHistory: true });
      // Every request the client sends is one a v1 host knows.
      const recordedTypes = new Set(clientMsgs.map((m) => m.type));
      for (const req of received) {
        expect(recordedTypes.has(req.type), `unrecorded request ${req.type}`).toBe(true);
        expectShape(requestFor(req.type), req, `${req.type} request`);
      }

      const outputs = [];
      const statuses = [];
      const exits = [];
      client.onOutput((e) => outputs.push(e));
      client.onStatus((e) => statuses.push(e));
      client.onExit((e) => exits.push(e));
      for (const type of ['output', 'status', 'exit']) {
        peer.write(JSON.stringify(recordedEvent(type)) + '\n');
      }
      await until(() => exits.length === 1);
      const output = without(recordedEvent('output'), 'v', 'type');
      const status = without(recordedEvent('status'), 'v', 'type');
      const exit = without(recordedEvent('exit'), 'v', 'type');
      expect(outputs).toEqual([output]);
      expect(statuses).toEqual([status]);
      expect(exits).toEqual([exit]);
    } finally {
      await client.close();
      await new Promise((r) => server.close(r));
    }
  });
});
