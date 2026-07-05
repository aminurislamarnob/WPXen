import { describe, it, expect } from 'vitest';
import opcache from '../electron/services/opcache.cjs';

describe('renderOpcacheIni', () => {
  it('emits directives and wpherd markers for defaults', () => {
    const defaults = {};
    for (const s of opcache.OPCACHE_SETTINGS) defaults[s.key] = s.default;
    const ini = opcache.renderOpcacheIni(defaults);

    expect(ini).toContain('opcache.enable = 1');
    expect(ini).toContain('opcache.enable_cli = 1');
    expect(ini).toContain('opcache.memory_consumption = 128');
    expect(ini).toContain('opcache.max_accelerated_files = 10000');
    expect(ini).toContain('opcache.revalidate_freq = 2');
    expect(ini).toContain('opcache.validate_timestamps = 1');
    expect(ini).toContain('; wpherd:enable=1');
    expect(ini).toContain('; wpherd:memory_consumption=128');
  });

  it('renders a disabled state as opcache.enable = 0', () => {
    const ini = opcache.renderOpcacheIni({ enable: false, memory_consumption: 256 });
    expect(ini).toContain('opcache.enable = 0');
    expect(ini).toContain('opcache.enable_cli = 0');
    expect(ini).toContain('; wpherd:enable=0');
    expect(ini).toContain('opcache.memory_consumption = 256');
  });

  it('falls back to defaults for missing keys', () => {
    const ini = opcache.renderOpcacheIni({});
    expect(ini).toContain('opcache.memory_consumption = 128');
  });
});

describe('parseOpcacheIni round-trip', () => {
  it('reads values back out of a rendered ini', () => {
    const values = {
      enable: false,
      memory_consumption: 256,
      max_accelerated_files: 20000,
      revalidate_freq: 0,
      validate_timestamps: false,
    };
    const parsed = opcache.parseOpcacheIni(opcache.renderOpcacheIni(values));
    expect(parsed).toEqual(values);
  });

  it('defaults every key when the ini has no markers', () => {
    const parsed = opcache.parseOpcacheIni('; unrelated file\n');
    expect(parsed.enable).toBe(true);
    expect(parsed.memory_consumption).toBe(128);
    expect(parsed.validate_timestamps).toBe(true);
  });

  it('tolerates empty / null input', () => {
    expect(opcache.parseOpcacheIni('').memory_consumption).toBe(128);
    expect(opcache.parseOpcacheIni(null).enable).toBe(true);
  });
});

describe('validateOpcacheValue', () => {
  const mem = opcache.OPCACHE_SETTINGS.find((s) => s.key === 'memory_consumption');
  const enable = opcache.OPCACHE_SETTINGS.find((s) => s.key === 'enable');

  it('coerces bool inputs', () => {
    expect(opcache.validateOpcacheValue(enable, '1')).toBe(true);
    expect(opcache.validateOpcacheValue(enable, 0)).toBe(false);
    expect(opcache.validateOpcacheValue(enable, true)).toBe(true);
  });

  it('rejects non-numeric bool inputs', () => {
    expect(() => opcache.validateOpcacheValue(enable, 'maybe')).toThrow();
  });

  it('parses and range-checks integers', () => {
    expect(opcache.validateOpcacheValue(mem, '256')).toBe(256);
    expect(() => opcache.validateOpcacheValue(mem, '4')).toThrow(/at least/);
    expect(() => opcache.validateOpcacheValue(mem, '99999')).toThrow(/at most/);
    expect(() => opcache.validateOpcacheValue(mem, 'abc')).toThrow(/number/);
  });
});

describe('parseLiveStats', () => {
  it('converts bytes to MB and passes through hit rate', () => {
    const stats = opcache.parseLiveStats(
      JSON.stringify({
        enabled: true,
        used_memory: 10 * 1048576,
        free_memory: 118 * 1048576,
        wasted_memory: 0,
        cached_scripts: 1204,
        hits: 982,
        misses: 18,
        hit_rate: 98.2,
      })
    );
    expect(stats.enabled).toBe(true);
    expect(stats.usedMB).toBe(10);
    expect(stats.totalMB).toBe(128);
    expect(stats.cachedScripts).toBe(1204);
    expect(stats.hitRate).toBe(98.2);
  });

  it('reports disabled OpCache', () => {
    expect(opcache.parseLiveStats(JSON.stringify({ enabled: false }))).toEqual({
      enabled: false,
    });
  });

  it('accepts an already-parsed object', () => {
    expect(opcache.parseLiveStats({ enabled: false })).toEqual({ enabled: false });
  });

  it('returns null on invalid JSON', () => {
    expect(opcache.parseLiveStats('<html>not json</html>')).toBeNull();
  });

  it('leaves missing memory fields null', () => {
    const stats = opcache.parseLiveStats({ enabled: true, hit_rate: 50 });
    expect(stats.usedMB).toBeNull();
    expect(stats.totalMB).toBeNull();
    expect(stats.hitRate).toBe(50);
  });
});
