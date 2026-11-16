import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  PROTOCOL_VERSION,
  MAX_IDLE_MS,
  createSessionHost,
  parseClientMessage,
  parseHostMessage,
} from '../electron/services/sessionHost.cjs';
import { createSessionHostClient } from '../electron/services/sessionHostClient.cjs';

const until = async (fn, timeout = 3000) => {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeout) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

function fakePtyFactory(ptys) {
  let nextPid = 3000;
  return (file, args, opts) => {
    const handlers = { data: [], exit: [] };
    const p = {
      pid: (nextPid += 10),
      spawnedWith: { file, args, opts },
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

let tmp;
let sockPath;
let ptys;
let clock;
let host;
let exitedCount;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-shost-'));
  sockPath = path.join(tmp, 'wpxen-host.sock');
  ptys = [];
  clock = 1_700_000_000_000;
  exitedCount = 0;

  host = createSessionHost({
    socketPath: sockPath,
    appVersion: '0.6.3',
    spawnPty: fakePtyFactory(ptys),
    now: () => clock,
    onExit: () => {
      exitedCount++;
    },
  });
  await host.start();
});

afterEach(async () => {
  await host?.close?.();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Session Host server and client (#230)', () => {
  it('starts, creates the socket with mode 0600, and answers hello with appVersion and protocolVersion', async () => {
    expect(fs.existsSync(sockPath)).toBe(true);
    expect(fs.statSync(sockPath).mode & 0o777).toBe(0o600);

    const client = createSessionHostClient({ socketPath: sockPath });
    try {
      const hello = await client.hello();
      expect(hello).toMatchObject({
        v: PROTOCOL_VERSION,
        ok: true,
        appVersion: '0.6.3',
        protocolVersion: PROTOCOL_VERSION,
      });
    } finally {
      await client.close();
    }
  });

  it('starts a Session, writes, resizes, stops, and delivers output in order and one exit event', async () => {
    const client = createSessionHostClient({ socketPath: sockPath });
    const outputs = [];
    const exits = [];
    client.onOutput((ev) => outputs.push(ev));
    client.onExit((ev) => exits.push(ev));

    try {
      const started = await client.start({
        sessionId: 's-1',
        file: '/bin/zsh',
        args: ['-il'],
        cwd: tmp,
        cols: 80,
        rows: 24,
        env: { TERM: 'xterm-256color' },
      });
      expect(started).toMatchObject({ sessionId: 's-1', pid: expect.any(Number) });

      await client.write('s-1', 'echo hi\r');
      await client.resize('s-1', 132, 42);
      expect(ptys[0].write).toHaveBeenCalledWith('echo hi\r');
      expect(ptys[0].resize).toHaveBeenCalledWith(132, 42);

      ptys[0].emitData('chunk-1 ');
      ptys[0].emitData('chunk-2 ');
      ptys[0].emitData('chunk-3');

      await until(() => outputs.length === 3);
      expect(outputs.map((o) => o.data)).toEqual(['chunk-1 ', 'chunk-2 ', 'chunk-3']);

      ptys[0].emitExit(0);
      // Duplicate exit from pty must be ignored.
      ptys[0].emitExit(1);
      ptys[0].emitData('after-exit');

      await until(() => exits.length >= 1);
      expect(exits).toEqual([{ sessionId: 's-1', exitCode: 0 }]);
      expect(outputs).toHaveLength(3);
    } finally {
      await client.close();
    }
  });

  it('keeps a Session running after client disconnect so a second client can list and attach to it', async () => {
    const client1 = createSessionHostClient({ socketPath: sockPath });
    await client1.start({
      sessionId: 's-persist',
      file: '/bin/zsh',
      args: ['-il'],
      cwd: tmp,
    });
    ptys[0].emitData('while-connected ');
    await client1.close();

    // Output produced while no client is connected stays buffered in the host.
    ptys[0].emitData('while-disconnected');
    expect(exitedCount).toBe(0);

    const client2 = createSessionHostClient({ socketPath: sockPath });
    try {
      const list = await client2.list();
      expect(list).toEqual([
        expect.objectContaining({
          sessionId: 's-persist',
          cwd: tmp,
          exited: false,
        }),
      ]);

      const attached = await client2.attach('s-persist');
      expect(attached).toMatchObject({
        sessionId: 's-persist',
        data: 'while-connected while-disconnected',
        exited: false,
      });

      // Live output after attach reaches the second client.
      const liveOut = [];
      client2.onOutput((ev) => liveOut.push(ev));
      ptys[0].emitData(' and-live');
      await until(() => liveOut.length === 1);
      expect(liveOut[0]).toEqual({ sessionId: 's-persist', data: ' and-live' });
    } finally {
      await client2.close();
    }
  });

  it('exits when its last Session has ended and no client is connected, and not before', async () => {
    const client = createSessionHostClient({ socketPath: sockPath });
    await client.start({
      sessionId: 's-life-1',
      file: '/bin/zsh',
      args: ['-il'],
      cwd: tmp,
    });
    await client.start({
      sessionId: 's-life-2',
      file: '/bin/zsh',
      args: ['-il'],
      cwd: tmp,
    });

    // First session exits while client is connected — host stays up.
    ptys[0].emitExit(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(exitedCount).toBe(0);

    // Second session exits while client is still connected — host stays up until client disconnects.
    ptys[1].emitExit(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(exitedCount).toBe(0);

    // Client disconnects after all sessions have ended → host exits.
    await client.close();
    await until(() => exitedCount === 1);
  });

  it('exits when the last Session ends after the client has already disconnected', async () => {
    const client = createSessionHostClient({ socketPath: sockPath });
    await client.start({
      sessionId: 's-alone',
      file: '/bin/zsh',
      args: ['-il'],
      cwd: tmp,
    });
    await client.close();

    // Still one live session, so host has not exited.
    await new Promise((r) => setTimeout(r, 30));
    expect(exitedCount).toBe(0);

    // Last session ends while no client is connected → host exits immediately.
    ptys[0].emitExit(0);
    await until(() => exitedCount === 1);
  });

  it('answers malformed or unknown messages with an error reply and never crashes', async () => {
    const conn = net.connect(sockPath);
    await new Promise((r) => conn.on('connect', r));

    const lines = [];
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        lines.push(JSON.parse(buf.slice(0, idx)));
        buf = buf.slice(idx + 1);
      }
    });

    conn.write('not valid json\n');
    conn.write(JSON.stringify({ v: 1, id: 10, type: 'unknown_verb' }) + '\n');
    conn.write(JSON.stringify({ v: 1, id: 11, type: 'hello' }) + '\n');

    await until(() => lines.length >= 3);
    expect(lines[0]).toMatchObject({ v: 1, ok: false, error: expect.any(String) });
    expect(lines[1]).toMatchObject({
      v: 1,
      id: 10,
      ok: false,
      error: expect.stringMatching(/unknown/i),
    });
    expect(lines[2]).toMatchObject({
      v: 1,
      id: 11,
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
    });
    conn.destroy();
  });

  it('tracks status, title and unread in the host while disconnected and clears unread via mark-read (#232)', async () => {
    const client1 = createSessionHostClient({ socketPath: sockPath });
    await client1.start({
      sessionId: 's-status',
      file: '/bin/zsh',
      args: ['-il'],
      cwd: tmp,
      agent: true,
    });
    await client1.close();

    // Agent becomes busy, then finishes with a title while no client is connected.
    ptys[0].emitData('\x1b]0;⠋ Building\x07');
    ptys[0].emitData('\x1b]0;✳ Fixed auth\x07');

    const client2 = createSessionHostClient({ socketPath: sockPath });
    try {
      const list = await client2.list();
      expect(list[0]).toMatchObject({
        sessionId: 's-status',
        state: 'done',
        title: 'Fixed auth',
        unread: true,
      });

      const attached = await client2.attach('s-status');
      expect(attached).toMatchObject({
        sessionId: 's-status',
        state: 'done',
        title: 'Fixed auth',
        unread: true,
      });

      // Mark read in host and verify it persists for a third client.
      await client2.markRead('s-status', true);
    } finally {
      await client2.close();
    }

    const client3 = createSessionHostClient({ socketPath: sockPath });
    try {
      const list3 = await client3.list();
      expect(list3[0]).toMatchObject({
        sessionId: 's-status',
        state: 'done',
        title: 'Fixed auth',
        unread: false,
      });
    } finally {
      await client3.close();
    }
  });

  it('reports needs-input and unread when an agent waits for input while disconnected (#232)', async () => {
    const client1 = createSessionHostClient({ socketPath: sockPath });
    await client1.start({
      sessionId: 's-input',
      file: '/bin/zsh',
      args: ['-il'],
      cwd: tmp,
      agent: true,
    });
    await client1.close();

    ptys[0].emitData('\x1b]0;✋ Permission required\x07');

    const client2 = createSessionHostClient({ socketPath: sockPath });
    try {
      const list = await client2.list();
      expect(list[0]).toMatchObject({
        sessionId: 's-input',
        state: 'needs-input',
        unread: true,
      });
    } finally {
      await client2.close();
    }
  });

  it('stops all Sessions and exits after 24 hours with no client connected, and a client connecting resets the clock (#234)', async () => {
    expect(MAX_IDLE_MS).toBe(24 * 60 * 60 * 1000);

    const idleSock = path.join(tmp, 'wpxen-idle-24h.sock');
    const idlePtys = [];
    let idleClock = 1_700_000_000_000;
    let idleExited = 0;
    let scheduledTimer = null;

    const idleHost = createSessionHost({
      socketPath: idleSock,
      appVersion: '0.6.3',
      spawnPty: fakePtyFactory(idlePtys),
      now: () => idleClock,
      setTimeoutFn: (fn, ms) => {
        scheduledTimer = { fn, ms, cleared: false };
        return scheduledTimer;
      },
      clearTimeoutFn: (t) => {
        if (t) t.cleared = true;
      },
      onExit: () => {
        idleExited++;
      },
    });
    await idleHost.start();

    try {
      const c1 = createSessionHostClient({ socketPath: idleSock });
      await c1.start({ sessionId: 's-24h', file: '/bin/zsh', cwd: tmp });
      await c1.close();

      await until(() => scheduledTimer && !scheduledTimer.cleared);
      expect(scheduledTimer.ms).toBe(MAX_IDLE_MS);

      // Advance 20 hours, then a second client connects and disconnects -> resets the 24h clock.
      idleClock += 20 * 60 * 60 * 1000;
      const c2 = createSessionHostClient({ socketPath: idleSock });
      await c2.hello();
      expect(scheduledTimer.cleared).toBe(true);
      await c2.close();

      await until(() => scheduledTimer && !scheduledTimer.cleared);
      expect(idlePtys[0].kill).not.toHaveBeenCalled();
      expect(idleExited).toBe(0);

      // Advance 24 hours with no client connected -> stops all Sessions and exits.
      idleClock += MAX_IDLE_MS;
      scheduledTimer.fn();

      await until(() => idleExited === 1);
      expect(idlePtys[0].kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      await idleHost.close();
    }
  });
});

describe('protocol v1 contract fixture (#230)', () => {
  it('understands every recorded message in test/fixtures/session-host-protocol-v1.jsonl', () => {
    const file = path.join(__dirname, 'fixtures', 'session-host-protocol-v1.jsonl');
    const lines = fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

    expect(lines.length).toBeGreaterThanOrEqual(15);
    for (const entry of lines) {
      const raw = JSON.stringify(entry.message);
      if (entry.direction === 'client') {
        const parsed = parseClientMessage(raw);
        expect(parsed.ok, `client message failed: ${raw}`).toBe(true);
        expect(parsed.message.v).toBe(1);
        expect(parsed.message.type).toBe(entry.message.type);
      } else {
        const parsed = parseHostMessage(raw);
        expect(parsed.ok, `host message failed: ${raw}`).toBe(true);
        expect(parsed.message.v).toBe(1);
      }
    }
  });
});
