import { describe, it, expect, vi } from 'vitest';
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  RETRY_MS,
  STORE_KEY,
  findPhpUpdates,
  cleanVersion,
  createPhpUpdateChecker,
} from '../electron/services/phpUpdates.cjs';
import { phpUpdatesLabel } from '../src/lib/usePhpUpdates.js';

// `brew outdated --json=v2` formula records, shaped as Homebrew prints them.
const outdated = (name, installed, current, extra = {}) => ({
  name,
  installed_versions: [installed],
  current_version: current,
  pinned: false,
  pinned_version: null,
  ...extra,
});

const INSTALLED = [
  { version: '8.3', formula: 'php@8.3' },
  { version: '8.4', formula: 'php' },
  { version: '7.4', formula: 'php@7.4' },
];

function memoryStore(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: (k, d) => (k in data ? data[k] : d),
    set: (k, v) => {
      data[k] = v;
    },
  };
}

function makeChecker(overrides = {}) {
  let outdatedList = overrides.outdated || [];
  const timers = [];
  const deps = {
    refreshIndex: vi.fn(async () => {}),
    listInstalled: () => INSTALLED,
    listOutdated: vi.fn(async () => outdatedList),
    store: memoryStore(overrides.saved ? { [STORE_KEY]: overrides.saved } : {}),
    onChange: vi.fn(),
    onNew: vi.fn(),
    now: () => overrides.now ?? 1_000_000,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
    ...overrides.deps,
  };
  const checker = createPhpUpdateChecker(deps);
  return {
    checker,
    deps,
    timers,
    setOutdated: (list) => {
      outdatedList = list;
    },
  };
}

describe('findPhpUpdates', () => {
  it('matches installed PHP formulae, skipping other formulae and pinned ones', () => {
    const updates = findPhpUpdates(INSTALLED, [
      outdated('ada-url', '4.0.0_1', '4.0.0_2'),
      outdated('php', '8.4.14', '8.4.15'),
      outdated('php@8.3', '8.3.29', '8.3.30', { pinned: true }),
    ]);
    expect(updates).toEqual([
      { version: '8.4', formula: 'php', installed: '8.4.14', latest: '8.4.15' },
    ]);
  });

  it('matches tap formulae by full name and drops Homebrew rebuild suffixes', () => {
    const updates = findPhpUpdates(INSTALLED, [
      outdated('php@7.4', '7.4.32_7', '7.4.33_1', {
        full_name: 'shivammathur/php/php@7.4',
      }),
    ]);
    expect(updates).toEqual([
      { version: '7.4', formula: 'php@7.4', installed: '7.4.32', latest: '7.4.33' },
    ]);
    expect(cleanVersion('8.4.15_1')).toBe('8.4.15');
  });

  it('does not announce a rebuild of the same release', () => {
    expect(findPhpUpdates(INSTALLED, [outdated('php', '8.4.15_1', '8.4.15_2')])).toEqual(
      []
    );
  });

  it('sorts by version number', () => {
    const updates = findPhpUpdates(INSTALLED, [
      outdated('php', '8.4.14', '8.4.15'),
      outdated('php@7.4', '7.4.32', '7.4.33'),
      outdated('php@8.3', '8.3.29', '8.3.30'),
    ]);
    expect(updates.map((u) => u.version)).toEqual(['7.4', '8.3', '8.4']);
  });
});

describe('createPhpUpdateChecker', () => {
  it('refreshes the index, then reports updates and remembers when it checked', async () => {
    const { checker, deps } = makeChecker({
      outdated: [outdated('php', '8.4.14', '8.4.15')],
    });
    const state = await checker.check();
    expect(deps.refreshIndex).toHaveBeenCalledTimes(1);
    expect(state.updates).toHaveLength(1);
    expect(state.notice).toHaveLength(1);
    expect(state.checkedAt).toBe(1_000_000);
    expect(state.checking).toBe(false);
    expect(deps.store.data[STORE_KEY].checkedAt).toBe(1_000_000);
  });

  it('announces each release once', async () => {
    const { checker, deps, setOutdated } = makeChecker({
      outdated: [outdated('php', '8.4.14', '8.4.15')],
    });
    await checker.check();
    await checker.check();
    expect(deps.onNew).toHaveBeenCalledTimes(1);
    expect(deps.onNew.mock.calls[0][0][0].latest).toBe('8.4.15');

    setOutdated([outdated('php', '8.4.14', '8.4.16')]);
    await checker.check();
    expect(deps.onNew).toHaveBeenCalledTimes(2);
    expect(deps.onNew.mock.calls[1][0][0].latest).toBe('8.4.16');
  });

  it('does not re-announce after a restart (notified is persisted)', async () => {
    const first = makeChecker({ outdated: [outdated('php', '8.4.14', '8.4.15')] });
    await first.checker.check();
    const saved = first.deps.store.data[STORE_KEY];

    const second = makeChecker({
      saved,
      outdated: [outdated('php', '8.4.14', '8.4.15')],
    });
    expect(second.checker.getState().updates).toHaveLength(1);
    await second.checker.check();
    expect(second.deps.onNew).not.toHaveBeenCalled();
  });

  it('dismiss hides the notice for that release only', async () => {
    const { checker, setOutdated } = makeChecker({
      outdated: [outdated('php', '8.4.14', '8.4.15')],
    });
    await checker.check();
    const after = checker.dismiss();
    expect(after.notice).toEqual([]);
    expect(after.updates).toHaveLength(1); // the PHP page still offers it

    setOutdated([outdated('php', '8.4.14', '8.4.16')]);
    const newer = await checker.check();
    expect(newer.notice.map((u) => u.latest)).toEqual(['8.4.16']);
  });

  it('clears an update once it is installed', async () => {
    const { checker, deps, setOutdated } = makeChecker({
      outdated: [outdated('php', '8.4.14', '8.4.15')],
    });
    await checker.check();
    setOutdated([]);
    const state = await checker.check({ refresh: false });
    expect(state.updates).toEqual([]);
    expect(deps.refreshIndex).toHaveBeenCalledTimes(1); // not on the re-check
  });

  it('still reads the local index when the refresh fails, and does not count it as checked', async () => {
    const { checker } = makeChecker({
      outdated: [outdated('php', '8.4.14', '8.4.15')],
      deps: {
        refreshIndex: async () => {
          throw new Error('Error: Failed to download\nmore detail');
        },
      },
    });
    const state = await checker.check();
    expect(state.updates).toHaveLength(1);
    expect(state.error).toBe('Couldn’t refresh Homebrew (Error: Failed to download).');
    expect(state.checkedAt).toBeNull();
  });

  it('shares one run between overlapping checks', async () => {
    const { checker, deps } = makeChecker();
    await Promise.all([checker.check(), checker.check()]);
    expect(deps.refreshIndex).toHaveBeenCalledTimes(1);
  });
});

describe('schedule', () => {
  it('waits a couple of minutes after launch, then checks daily', async () => {
    const { checker, deps, timers } = makeChecker();
    checker.start();
    expect(timers[0].ms).toBe(FIRST_CHECK_DELAY_MS);
    await timers[0].fn();
    expect(deps.refreshIndex).toHaveBeenCalledTimes(1);
    expect(timers[1].ms).toBe(CHECK_INTERVAL_MS);
  });

  it('honours a recent check from before a restart', () => {
    const now = 10 * CHECK_INTERVAL_MS;
    const { checker, timers } = makeChecker({
      now,
      saved: { checkedAt: now - CHECK_INTERVAL_MS / 2 },
    });
    checker.start();
    expect(timers[0].ms).toBe(CHECK_INTERVAL_MS / 2);
  });

  it('skips the check while the setting is off, but keeps the timer', async () => {
    const { checker, deps, timers } = makeChecker({ deps: { enabled: () => false } });
    checker.start();
    await timers[0].fn();
    expect(deps.refreshIndex).not.toHaveBeenCalled();
    expect(timers).toHaveLength(2);
  });

  it('retries within the hour after a failed check', async () => {
    const { checker, timers } = makeChecker({
      deps: {
        refreshIndex: async () => {
          throw new Error('offline');
        },
      },
    });
    checker.start();
    await timers[0].fn();
    expect(timers[1].ms).toBe(RETRY_MS);
  });
});

describe('phpUpdatesLabel', () => {
  it('names one or several releases', () => {
    expect(phpUpdatesLabel([{ version: '8.4', latest: '8.4.15' }])).toBe('PHP 8.4.15');
    expect(
      phpUpdatesLabel([
        { version: '8.3', latest: '8.3.30' },
        { version: '8.4', latest: '8.4.15' },
      ])
    ).toBe('PHP 8.3.30 and 8.4.15');
  });
});
