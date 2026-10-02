import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import keepAwake from '../electron/services/keepAwake.cjs';

// caffeinate and powerSaveBlocker are swapped through the module's own seam —
// .cjs services load via Node's CJS loader, out of vi.mock's reach — so these
// tests describe what the service does to the machine, not how it tracks it.

// A fake caffeinate child. `running` flips on spawn and off on exit, so
// "how many are alive" is observable without peeking at module state.
function fakeChild() {
  const c = new EventEmitter();
  c.running = false;
  c.kill = vi.fn(() => {
    c.running = false;
    c.emit('exit', null, 'SIGTERM');
  });
  return c;
}

let children;
let spawn;
let blocker;
let log;
let statuses;

// What the outside world sees: caffeinate processes alive + blockers held.
function liveCaffeinate() {
  return children.filter((c) => c.running).length;
}

beforeEach(() => {
  vi.useFakeTimers();
  children = [];
  spawn = vi.fn(() => {
    const c = fakeChild();
    children.push(c);
    // Real spawn reports success asynchronously, on the next tick.
    queueMicrotask(() => {
      if (c.failWith) {
        c.emit('error', c.failWith);
        return;
      }
      c.running = true;
      c.emit('spawn');
    });
    return c;
  });
  let nextId = 1;
  const held = new Set();
  blocker = {
    held,
    start: vi.fn(() => {
      const id = nextId++;
      held.add(id);
      return id;
    }),
    stop: vi.fn((id) => held.delete(id)),
  };
  log = vi.fn();
  keepAwake.__setDeps({ spawn, powerSaveBlocker: blocker, pid: 4242, log });
  statuses = [];
  keepAwake.onStatusChange((s) => statuses.push(s));
});

afterEach(() => {
  keepAwake.dispose();
  vi.useRealTimers();
});

const tick = () => vi.advanceTimersByTimeAsync(0);

describe('modes', () => {
  it('holds nothing while off (the default)', async () => {
    await tick();
    expect(keepAwake.getStatus()).toEqual({
      mode: 'off',
      active: false,
      workingCount: 0,
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(blocker.start).not.toHaveBeenCalled();
  });

  it('On spawns caffeinate -i -s tied to the app pid', async () => {
    keepAwake.setMode('on');
    await tick();
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/caffeinate',
      ['-i', '-s', '-w', '4242'],
      expect.anything()
    );
    expect(liveCaffeinate()).toBe(1);
    expect(blocker.held.size).toBe(0);
    expect(keepAwake.getStatus()).toEqual({ mode: 'on', active: true, workingCount: 0 });
  });

  it('switching back to Off releases the hold', async () => {
    keepAwake.setMode('on');
    await tick();
    keepAwake.setMode('off');
    await tick();
    expect(liveCaffeinate()).toBe(0);
    expect(keepAwake.getStatus().active).toBe(false);
  });

  it('Agent mode with no working agents holds nothing', async () => {
    keepAwake.setMode('agent');
    await tick();
    expect(spawn).not.toHaveBeenCalled();
    expect(keepAwake.getStatus()).toEqual({
      mode: 'agent',
      active: false,
      workingCount: 0,
    });
  });

  it('ignores an unknown mode', async () => {
    keepAwake.setMode('on');
    keepAwake.setMode('always');
    await tick();
    expect(keepAwake.getStatus().mode).toBe('on');
  });

  it('re-selecting the same mode does not spawn a second caffeinate', async () => {
    keepAwake.setMode('on');
    await tick();
    keepAwake.setMode('on');
    await tick();
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('fallback', () => {
  it('uses prevent-display-sleep when caffeinate fails to spawn', async () => {
    spawn.mockImplementationOnce(() => {
      const c = fakeChild();
      children.push(c);
      queueMicrotask(() => c.emit('error', new Error('ENOENT')));
      return c;
    });
    keepAwake.setMode('on');
    await tick();
    expect(liveCaffeinate()).toBe(0);
    expect(blocker.start).toHaveBeenCalledWith('prevent-display-sleep');
    expect(blocker.held.size).toBe(1);
    expect(keepAwake.getStatus().active).toBe(true);
  });

  it('uses the fallback when spawn throws synchronously', async () => {
    spawn.mockImplementationOnce(() => {
      throw new Error('EAGAIN');
    });
    keepAwake.setMode('on');
    await tick();
    expect(blocker.held.size).toBe(1);
    expect(keepAwake.getStatus().active).toBe(true);
  });

  it('releasing stops the fallback blocker', async () => {
    spawn.mockImplementationOnce(() => {
      throw new Error('EAGAIN');
    });
    keepAwake.setMode('on');
    await tick();
    keepAwake.setMode('off');
    expect(blocker.held.size).toBe(0);
  });

  it('reports inactive when neither mechanism can hold', async () => {
    spawn.mockImplementation(() => {
      throw new Error('EAGAIN');
    });
    keepAwake.__setDeps({ powerSaveBlocker: undefined });
    keepAwake.setMode('on');
    await tick();
    expect(keepAwake.getStatus()).toEqual({ mode: 'on', active: false, workingCount: 0 });
  });
});

describe('unexpected caffeinate exit', () => {
  async function crash() {
    const c = children.at(-1);
    c.running = false;
    c.emit('exit', 1, null);
    await tick();
  }

  it('bridges with the fallback, then retries caffeinate after 30s', async () => {
    keepAwake.setMode('on');
    await tick();
    await crash();

    expect(blocker.held.size).toBe(1);
    expect(keepAwake.getStatus().active).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(liveCaffeinate()).toBe(1);
    // Never both at once: the blocker goes as soon as caffeinate is up.
    expect(blocker.held.size).toBe(0);
  });

  it('logs the first unexpected exit only', async () => {
    keepAwake.setMode('on');
    await tick();
    await crash();
    await vi.advanceTimersByTimeAsync(30_000);
    await crash();
    expect(log.mock.calls.filter(([m]) => /exited unexpectedly/.test(m))).toHaveLength(1);
  });

  it('does not retry once the hold is no longer wanted', async () => {
    keepAwake.setMode('on');
    await tick();
    await crash();
    keepAwake.setMode('off');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(blocker.held.size).toBe(0);
  });

  it('a kill we asked for is not treated as unexpected', async () => {
    keepAwake.setMode('on');
    await tick();
    keepAwake.setMode('off');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('resume and dispose', () => {
  it('resume leaves a live hold alone', async () => {
    keepAwake.setMode('on');
    await tick();
    keepAwake.handleResume();
    await tick();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(liveCaffeinate()).toBe(1);
  });

  it('resume with nothing wanted holds nothing', async () => {
    keepAwake.handleResume();
    await tick();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('dispose releases caffeinate, the blocker and pending retries', async () => {
    keepAwake.setMode('on');
    await tick();
    const c = children.at(-1);
    c.running = false;
    c.emit('exit', 1, null);
    await tick();

    keepAwake.dispose();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(liveCaffeinate()).toBe(0);
    expect(blocker.held.size).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('status publishing', () => {
  it('publishes only when the status changes', async () => {
    keepAwake.setMode('on');
    await tick();
    keepAwake.setMode('on');
    keepAwake.handleResume();
    await tick();
    keepAwake.setMode('off');
    await tick();
    expect(statuses).toEqual([
      { mode: 'on', active: true, workingCount: 0 },
      { mode: 'off', active: false, workingCount: 0 },
    ]);
  });

  it('publishes the mode change even when nothing is held', async () => {
    keepAwake.setMode('agent');
    await tick();
    expect(statuses).toEqual([{ mode: 'agent', active: false, workingCount: 0 }]);
  });
});

describe('Agent mode', () => {
  let sessions;
  let notify;

  // A Session snapshot as agents.listAllSessions() returns it.
  const session = (over = {}) => ({
    sessionId: 's1',
    isAgent: true,
    state: 'working',
    exited: false,
    lastOutputAt: Date.now(),
    ...over,
  });

  function watch(initial) {
    sessions = initial;
    keepAwake.watchSessions({
      list: () => sessions,
      subscribe: (cb) => {
        notify = cb;
        return () => {
          notify = null;
        };
      },
    });
  }

  // Replace the list and fire the change feed, the way agents.cjs does.
  async function change(next) {
    sessions = next;
    notify?.(next);
    await tick();
  }

  beforeEach(() => {
    keepAwake.setMode('agent');
  });

  it('holds while an agent Session is working', async () => {
    watch([session()]);
    await tick();
    expect(liveCaffeinate()).toBe(1);
    expect(keepAwake.getStatus()).toEqual({
      mode: 'agent',
      active: true,
      workingCount: 1,
    });
  });

  it.each(['done', 'needs-input', 'idle', 'exited', 'error'])(
    'releases immediately when the agent moves to %s',
    async (state) => {
      watch([session()]);
      await tick();
      await change([session({ state })]);
      expect(liveCaffeinate()).toBe(0);
      expect(keepAwake.getStatus()).toEqual({
        mode: 'agent',
        active: false,
        workingCount: 0,
      });
    }
  );

  it('ignores a plain shell Session even while its title spins', async () => {
    watch([session({ isAgent: false })]);
    await tick();
    expect(spawn).not.toHaveBeenCalled();
    expect(keepAwake.getStatus().workingCount).toBe(0);
  });

  it('ignores an exited Session whatever its last state', async () => {
    watch([session({ exited: true })]);
    await tick();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('holds until every working agent has stopped', async () => {
    watch([session({ sessionId: 'a' }), session({ sessionId: 'b' })]);
    await tick();
    expect(keepAwake.getStatus().workingCount).toBe(2);

    await change([
      session({ sessionId: 'a', state: 'done' }),
      session({ sessionId: 'b' }),
    ]);
    expect(liveCaffeinate()).toBe(1);
    expect(keepAwake.getStatus().workingCount).toBe(1);

    await change([
      session({ sessionId: 'a', state: 'done' }),
      session({ sessionId: 'b', state: 'done' }),
    ]);
    expect(liveCaffeinate()).toBe(0);
  });

  it('a Session silent for 2 hours stops counting, released by the timer alone', async () => {
    watch([session()]);
    await tick();
    expect(liveCaffeinate()).toBe(1);

    await vi.advanceTimersByTimeAsync(keepAwake.STALE_AFTER_MS - 1);
    expect(liveCaffeinate()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(liveCaffeinate()).toBe(0);
    expect(keepAwake.getStatus()).toEqual({
      mode: 'agent',
      active: false,
      workingCount: 0,
    });
  });

  it('output since the last change keeps a Session counting past the cutoff', async () => {
    const s = session();
    watch([s]);
    await tick();
    // Output arrives without a change event: lastOutputAt advances in place.
    await vi.advanceTimersByTimeAsync(keepAwake.STALE_AFTER_MS / 2);
    s.lastOutputAt = Date.now();
    await vi.advanceTimersByTimeAsync(keepAwake.STALE_AFTER_MS / 2);
    expect(liveCaffeinate()).toBe(1);
    await vi.advanceTimersByTimeAsync(keepAwake.STALE_AFTER_MS / 2);
    expect(liveCaffeinate()).toBe(0);
  });

  it('a Session already stale when seen never counts', async () => {
    watch([session({ lastOutputAt: Date.now() - keepAwake.STALE_AFTER_MS })]);
    await tick();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('On and Off ignore Session changes', async () => {
    watch([]);
    keepAwake.setMode('off');
    await change([session()]);
    expect(spawn).not.toHaveBeenCalled();

    keepAwake.setMode('on');
    await tick();
    await change([session({ state: 'done' })]);
    expect(liveCaffeinate()).toBe(1);
  });

  it('switching to Agent mode picks up agents already working', async () => {
    keepAwake.setMode('off');
    watch([session()]);
    await tick();
    expect(spawn).not.toHaveBeenCalled();
    keepAwake.setMode('agent');
    await tick();
    expect(liveCaffeinate()).toBe(1);
  });

  it('resume drops Sessions that went stale while the Mac slept', async () => {
    watch([session()]);
    await tick();
    // Wall-clock jumps across sleep without the timer having fired yet.
    vi.setSystemTime(Date.now() + keepAwake.STALE_AFTER_MS + 1);
    keepAwake.handleResume();
    await tick();
    expect(liveCaffeinate()).toBe(0);
  });

  it('dispose stops watching Sessions', async () => {
    watch([session()]);
    await tick();
    keepAwake.dispose();
    expect(notify).toBeNull();
  });
});
