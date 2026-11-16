import { describe, it, expect, vi } from 'vitest';
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  RETRY_MS,
  STORE_KEY,
  RELEASES_PAGE,
  compareVersions,
  parseRelease,
  pickDownload,
  createAppUpdateChecker,
} from '../electron/services/appUpdates.cjs';
import { appUpdateStatusText } from '../src/lib/useAppUpdates.js';

// GitHub `/releases/latest` JSON, trimmed to the keys the checker reads.
const release = (version, extra = {}) => ({
  tag_name: `v${version}`,
  name: `v${version}`,
  html_url: `${RELEASES_PAGE}/tag/v${version}`,
  draft: false,
  prerelease: false,
  published_at: '2026-11-16T10:00:00Z',
  assets: [
    {
      name: `WPXen-${version}-arm64.dmg`,
      browser_download_url: `${RELEASES_PAGE}/download/v${version}/WPXen-${version}-arm64.dmg`,
    },
    {
      name: `WPXen-${version}.dmg`,
      browser_download_url: `${RELEASES_PAGE}/download/v${version}/WPXen-${version}.dmg`,
    },
    { name: `WPXen-${version}-arm64.dmg.blockmap`, browser_download_url: 'x' },
  ],
  ...extra,
});

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
  let latest = overrides.latest ?? release('0.6.3');
  const timers = [];
  const deps = {
    currentVersion: overrides.current || '0.6.2',
    arch: overrides.arch || 'arm64',
    fetchLatest: vi.fn(async () => latest),
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
  return {
    checker: createAppUpdateChecker(deps),
    deps,
    timers,
    setLatest: (r) => {
      latest = r;
    },
  };
}

describe('compareVersions', () => {
  it('compares numerically, not as text', () => {
    expect(compareVersions('0.6.10', '0.6.9')).toBe(1);
    expect(compareVersions('v0.6.2', '0.6.2')).toBe(0);
    expect(compareVersions('0.6.2', '1.0.0')).toBe(-1);
  });

  it('ranks a prerelease below its release, and junk below everything', () => {
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1);
    expect(compareVersions('nightly', '0.0.1')).toBe(-1);
  });
});

describe('parseRelease / pickDownload', () => {
  it('offers the DMG for this architecture by electron-builder’s names', () => {
    expect(parseRelease(release('0.6.3'), 'arm64').download).toMatch(
      /WPXen-0\.6\.3-arm64\.dmg$/
    );
    expect(parseRelease(release('0.6.3'), 'x64').download).toMatch(/WPXen-0\.6\.3\.dmg$/);
  });

  it('has no download when the release lacks that DMG', () => {
    expect(pickDownload([], '0.6.3', 'arm64')).toBeNull();
    expect(parseRelease(release('0.6.3', { assets: [] }), 'arm64').download).toBeNull();
  });

  it('rejects drafts, prereleases and tags that are not versions', () => {
    expect(() => parseRelease(release('0.6.3', { draft: true }))).toThrow();
    expect(() => parseRelease(release('0.6.3', { prerelease: true }))).toThrow();
    expect(() => parseRelease(release('0.6.3', { tag_name: 'latest' }))).toThrow();
  });
});

describe('createAppUpdateChecker', () => {
  it('reports a newer release and remembers when it checked', async () => {
    const { checker, deps } = makeChecker();
    const state = await checker.check();
    expect(state.available).toBe(true);
    expect(state.notice).toBe(true);
    expect(state.latest.version).toBe('0.6.3');
    expect(state.current).toBe('0.6.2');
    expect(state.checkedAt).toBe(1_000_000);
    expect(deps.store.data[STORE_KEY].checkedAt).toBe(1_000_000);
  });

  it('reports nothing when the running version is the latest, or newer', async () => {
    expect((await makeChecker({ current: '0.6.3' }).checker.check()).available).toBe(
      false
    );
    expect((await makeChecker({ current: '0.7.0' }).checker.check()).available).toBe(
      false
    );
  });

  it('announces each release once, across restarts', async () => {
    const first = makeChecker();
    await first.checker.check();
    await first.checker.check();
    expect(first.deps.onNew).toHaveBeenCalledTimes(1);

    const second = makeChecker({ saved: first.deps.store.data[STORE_KEY] });
    await second.checker.check();
    expect(second.deps.onNew).not.toHaveBeenCalled();

    second.setLatest(release('0.6.4'));
    await second.checker.check();
    expect(second.deps.onNew).toHaveBeenCalledTimes(1);
    expect(second.deps.onNew.mock.calls[0][0].version).toBe('0.6.4');
  });

  it('dismiss hides the notice for that release only', async () => {
    const { checker, setLatest } = makeChecker();
    await checker.check();
    const after = checker.dismiss();
    expect(after.notice).toBe(false);
    expect(after.available).toBe(true); // Settings → About still offers it

    setLatest(release('0.6.4'));
    expect((await checker.check()).notice).toBe(true);
  });

  it('clears the update once WPXen itself is updated', async () => {
    const first = makeChecker();
    await first.checker.check();
    const updated = makeChecker({
      current: '0.6.3',
      saved: first.deps.store.data[STORE_KEY],
    });
    expect(updated.checker.getState().available).toBe(false);
  });

  it('keeps the last known release when a check fails, and does not count it', async () => {
    const { checker, deps } = makeChecker();
    await checker.check();
    deps.fetchLatest.mockRejectedValueOnce(new Error('GitHub answered 503\nbody'));
    const state = await checker.check();
    expect(state.error).toBe('Couldn’t check for updates (GitHub answered 503).');
    expect(state.latest.version).toBe('0.6.3');
    expect(state.checkedAt).toBe(1_000_000);
  });

  it('shares one request between overlapping checks', async () => {
    const { checker, deps } = makeChecker();
    await Promise.all([checker.check(), checker.check()]);
    expect(deps.fetchLatest).toHaveBeenCalledTimes(1);
  });
});

describe('schedule', () => {
  it('waits a couple of minutes after launch, then checks daily', async () => {
    const { checker, deps, timers } = makeChecker();
    checker.start();
    expect(timers[0].ms).toBe(FIRST_CHECK_DELAY_MS);
    await timers[0].fn();
    expect(deps.fetchLatest).toHaveBeenCalledTimes(1);
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
    expect(deps.fetchLatest).not.toHaveBeenCalled();
    expect(timers).toHaveLength(2);
  });

  it('retries within the hour after a failed check', async () => {
    const { checker, timers } = makeChecker({
      deps: {
        fetchLatest: async () => {
          throw new Error('offline');
        },
      },
    });
    checker.start();
    await timers[0].fn();
    expect(timers[1].ms).toBe(RETRY_MS);
  });
});

describe('appUpdateStatusText', () => {
  it('says what the check found', () => {
    expect(appUpdateStatusText({ checking: true })).toBe('Checking for updates…');
    expect(
      appUpdateStatusText({
        available: true,
        current: '0.6.2',
        latest: { version: '0.6.3' },
      })
    ).toBe('WPXen 0.6.3 is available. You have 0.6.2.');
    expect(appUpdateStatusText({ current: '0.6.3', checkedAt: 1 })).toBe(
      'WPXen 0.6.3 is the latest version.'
    );
  });
});
