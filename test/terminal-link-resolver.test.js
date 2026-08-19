import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLinkResolver } from '../src/lib/terminal/linkResolver.js';

const hit = (resolved, isDirectory = false) => ({ exists: true, isDirectory, resolved });
const miss = { exists: false };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createLinkResolver', () => {
  it('resolves an existing path', async () => {
    const stat = vi.fn().mockResolvedValue(hit('/site/wp-config.php'));
    const r = createLinkResolver(stat);
    expect(await r.resolve('wp-config.php')).toEqual({
      resolved: '/site/wp-config.php',
      isDirectory: false,
    });
  });

  it('reports directories', async () => {
    const r = createLinkResolver(
      vi.fn().mockResolvedValue(hit('/site/wp-content', true))
    );
    expect((await r.resolve('wp-content')).isDirectory).toBe(true);
  });

  it('returns null for a non-existent path', async () => {
    const r = createLinkResolver(vi.fn().mockResolvedValue(miss));
    expect(await r.resolve('nope.php')).toBeNull();
  });

  it('returns null when the stat callback throws', async () => {
    const r = createLinkResolver(vi.fn().mockRejectedValue(new Error('ipc down')));
    expect(await r.resolve('a.php')).toBeNull();
  });

  it('caches hits — one stat for repeated lookups', async () => {
    const stat = vi.fn().mockResolvedValue(hit('/site/a.php'));
    const r = createLinkResolver(stat);
    await r.resolve('a.php');
    await r.resolve('a.php');
    await r.resolve('a.php');
    expect(stat).toHaveBeenCalledTimes(1);
  });

  it('caches misses too (a redrawing TUI must not re-stat every frame)', async () => {
    const stat = vi.fn().mockResolvedValue(miss);
    const r = createLinkResolver(stat);
    await r.resolve('nope.php');
    await r.resolve('nope.php');
    expect(stat).toHaveBeenCalledTimes(1);
  });

  it('re-stats after the TTL elapses', async () => {
    const stat = vi.fn().mockResolvedValue(miss);
    const r = createLinkResolver(stat, { ttlMs: 10_000 });
    await r.resolve('later.php');
    expect(stat).toHaveBeenCalledTimes(1);

    // A file created after the failed lookup must become linkable.
    stat.mockResolvedValue(hit('/site/later.php'));
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await r.resolve('later.php')).toEqual({
      resolved: '/site/later.php',
      isDirectory: false,
    });
    expect(stat).toHaveBeenCalledTimes(2);
  });

  it('keeps the cache warm before the TTL elapses', async () => {
    const stat = vi.fn().mockResolvedValue(miss);
    const r = createLinkResolver(stat, { ttlMs: 10_000 });
    await r.resolve('x.php');
    await vi.advanceTimersByTimeAsync(9_000);
    await r.resolve('x.php');
    expect(stat).toHaveBeenCalledTimes(1);
  });

  it('skips candidates longer than 1024 chars without statting', async () => {
    const stat = vi.fn().mockResolvedValue(hit('/site/x'));
    const r = createLinkResolver(stat);
    expect(await r.resolve('a'.repeat(1025))).toBeNull();
    expect(stat).not.toHaveBeenCalled();
  });

  it('skips empty and whitespace-only candidates', async () => {
    const stat = vi.fn().mockResolvedValue(hit('/site/x'));
    const r = createLinkResolver(stat);
    expect(await r.resolve('')).toBeNull();
    expect(await r.resolve('   ')).toBeNull();
    expect(stat).not.toHaveBeenCalled();
  });

  it('clear() drops cached entries and cancels the pending flush', async () => {
    const stat = vi.fn().mockResolvedValue(hit('/site/a.php'));
    const r = createLinkResolver(stat);
    await r.resolve('a.php');
    r.clear();
    await r.resolve('a.php');
    expect(stat).toHaveBeenCalledTimes(2);
    // No timer left behind after clear().
    expect(vi.getTimerCount()).toBe(1);
  });

  it('falls back to the candidate text when stat returns no resolved path', async () => {
    const r = createLinkResolver(vi.fn().mockResolvedValue({ exists: true }));
    expect(await r.resolve('a.php')).toEqual({ resolved: 'a.php', isDirectory: false });
  });
});
