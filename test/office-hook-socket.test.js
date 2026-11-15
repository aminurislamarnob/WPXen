import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import hookSocket from '../electron/services/office/hookSocket.cjs';
import engine from '../electron/services/office/engine.cjs';

// The hook transport: while the Office engine runs, the main process listens
// on an owner-only unix socket in userData; the forwarder (the dependency-free
// script Claude Code's hooks execute) writes one wrapped hook_event line to it
// and exits 0 — always, fast, even with no socket. This replaces the source's
// HTTP+token transport, so auth coverage becomes socket-permission coverage
// (spec #178 Testing). Everything runs in temp dirs through injected paths —
// the real userData is never touched.

const FORWARDER_SRC = path.join(
  __dirname,
  '..',
  'electron',
  'services',
  'office',
  'forwarder.cjs'
);

const until = async (fn, timeout = 4000) => {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeout) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

// Spawn the real forwarder with the system node (the node running vitest),
// piping `input` to stdin. Resolves { code, elapsedMs }.
function runForwarder(dir, input) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [path.join(dir, 'forwarder.cjs')], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, elapsedMs: Date.now() - startedAt }));
    child.stdin.end(input);
  });
}

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-hook-socket-'));
});

afterEach(() => {
  hookSocket.stop();
  engine.__reset();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('hookSocket', () => {
  it('listens on an owner-only (0600) socket in the given dir and dispatches valid events', async () => {
    const dispatch = vi.fn();
    const sockPath = hookSocket.start({ dir: tmp, dispatch });
    expect(sockPath).toBe(path.join(tmp, hookSocket.WPXEN_HOOK_SOCKET_NAME));

    await until(() => fs.existsSync(sockPath));
    // Owner-only, including at birth (bound under a 0o177 umask).
    await until(() => (fs.statSync(sockPath).mode & 0o777) === 0o600, 1000);

    const conn = net.connect(sockPath);
    await new Promise((r) => conn.on('connect', r));
    conn.end(
      JSON.stringify({
        type: 'hook_event',
        pid: 4242,
        hookData: { type: 'PermissionRequest', sessionId: 'sess-1' },
      }) + '\n'
    );

    await until(() => dispatch.mock.calls.length >= 1);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'hook_event',
      pid: 4242,
      hookData: expect.objectContaining({
        type: 'PermissionRequest',
        sessionId: 'sess-1',
      }),
    });
  });

  it("normalizes Claude Code's real field names (hook_event_name, session_id)", async () => {
    const dispatch = vi.fn();
    const sockPath = hookSocket.start({ dir: tmp, dispatch });
    await until(() => fs.existsSync(sockPath));

    const conn = net.connect(sockPath);
    await new Promise((r) => conn.on('connect', r));
    conn.end(
      JSON.stringify({
        type: 'hook_event',
        pid: 77,
        hookData: {
          hook_event_name: 'PreToolUse',
          session_id: 'sess-2',
          tool_name: 'Bash',
        },
      }) + '\n'
    );

    await until(() => dispatch.mock.calls.length >= 1);
    const event = dispatch.mock.calls[0][0];
    expect(event.hookData.type).toBe('PreToolUse');
    expect(event.hookData.sessionId).toBe('sess-2');
    expect(event.hookData.tool_name).toBe('Bash');
  });

  it('drops garbage and malformed events without dispatching or crashing', async () => {
    const dispatch = vi.fn();
    const sockPath = hookSocket.start({ dir: tmp, dispatch });
    await until(() => fs.existsSync(sockPath));

    const conn = net.connect(sockPath);
    await new Promise((r) => conn.on('connect', r));
    conn.write('not json at all\n');
    conn.write(JSON.stringify({ type: 'something_else', pid: 1 }) + '\n');
    conn.write(JSON.stringify({ type: 'hook_event', pid: 'NaN', hookData: {} }) + '\n');
    conn.write(JSON.stringify({ type: 'hook_event', pid: 5, hookData: null }) + '\n');
    // A valid one after the garbage proves the connection survived it.
    conn.end(
      JSON.stringify({ type: 'hook_event', pid: 5, hookData: { type: 'Stop' } }) + '\n'
    );

    await until(() => dispatch.mock.calls.length >= 1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].hookData.type).toBe('Stop');
  });

  it('unlinks a stale socket file on start and the live one on stop', async () => {
    const sockPath = path.join(tmp, hookSocket.WPXEN_HOOK_SOCKET_NAME);
    fs.writeFileSync(sockPath, 'stale'); // a leftover from a crashed run

    const dispatch = vi.fn();
    hookSocket.start({ dir: tmp, dispatch });
    await until(() => {
      try {
        return fs.statSync(sockPath).isSocket();
      } catch {
        return false;
      }
    });

    hookSocket.stop();
    await until(() => !fs.existsSync(sockPath));
  });
});

describe('forwarder (the real file, spawned)', () => {
  it('round-trips: a hook event on stdin arrives as a hook_event with pid = ppid, exit 0', async () => {
    fs.copyFileSync(FORWARDER_SRC, path.join(tmp, 'forwarder.cjs'));
    const dispatch = vi.fn();
    const sockPath = hookSocket.start({ dir: tmp, dispatch });
    await until(() => fs.existsSync(sockPath));

    const { code } = await runForwarder(
      tmp,
      JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'sess-3' })
    );
    expect(code).toBe(0);

    await until(() => dispatch.mock.calls.length >= 1);
    const event = dispatch.mock.calls[0][0];
    expect(event.type).toBe('hook_event');
    // ppid of the spawned forwarder is this test process.
    expect(event.pid).toBe(process.pid);
    expect(event.hookData.type).toBe('PermissionRequest');
    expect(event.hookData.sessionId).toBe('sess-3');
  });

  it('exits 0 fast and silently when the socket is absent (WPXen not running)', async () => {
    fs.copyFileSync(FORWARDER_SRC, path.join(tmp, 'forwarder.cjs'));
    const { code, elapsedMs } = await runForwarder(tmp, '{"hook_event_name":"Stop"}');
    expect(code).toBe(0);
    expect(elapsedMs).toBeLessThan(900); // well inside its own 1 s hard timeout
  });

  it('exits 0 on unparseable stdin', async () => {
    fs.copyFileSync(FORWARDER_SRC, path.join(tmp, 'forwarder.cjs'));
    hookSocket.start({ dir: tmp, dispatch: vi.fn() });
    const { code } = await runForwarder(tmp, 'not json');
    expect(code).toBe(0);
  });

  it('bakes the same socket name hookSocket listens on', () => {
    // The forwarder is dependency-free, so the name is duplicated there by
    // design — this is the sync guard (the PARTITION precedent).
    const src = fs.readFileSync(FORWARDER_SRC, 'utf8');
    expect(src).toContain(`'${hookSocket.WPXEN_HOOK_SOCKET_NAME}'`);
  });
});

describe('engine wiring', () => {
  it('engine start opens the hook socket, events flow to the reducer, stop closes it', async () => {
    const inertTailer = () => ({ on: () => {}, start: async () => {}, stop: () => {} });
    engine.__setDeps({
      scan: async (prev) => ({ events: [], snapshot: prev }),
      createTailer: inertTailer,
      pollIntervalMs: 60_000,
    });

    engine.start({ hookSocketDir: tmp });
    const sockPath = path.join(tmp, hookSocket.WPXEN_HOOK_SOCKET_NAME);
    await until(() => fs.existsSync(sockPath));

    // A session appears, then its permission prompt arrives over the socket.
    engine.dispatch({
      type: 'session_appeared',
      pid: 9001,
      sessionId: 'sess-9',
      cwd: '/tmp/proj',
      name: 'session',
      projectKey: 'proj',
      startedAt: Date.now(),
    });

    const conn = net.connect(sockPath);
    await new Promise((r) => conn.on('connect', r));
    conn.end(
      JSON.stringify({
        type: 'hook_event',
        pid: 9001,
        hookData: { hook_event_name: 'PermissionRequest', session_id: 'sess-9' },
      }) + '\n'
    );

    await until(() => engine.getOffice().sessions[9001]?.state === 'waiting_on_user');
    expect(engine.getOffice().sessions[9001].hookWaiting).toBe(true);

    engine.stop();
    await until(() => !fs.existsSync(sockPath));
  });

  it('engine without a hookSocketDir runs with no socket (inferred waiting keeps working)', async () => {
    engine.__setDeps({
      scan: async (prev) => ({ events: [], snapshot: prev }),
      pollIntervalMs: 60_000,
    });
    engine.start();
    expect(engine.isStarted()).toBe(true);
    expect(fs.existsSync(path.join(tmp, hookSocket.WPXEN_HOOK_SOCKET_NAME))).toBe(false);
  });
});
