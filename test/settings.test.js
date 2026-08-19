import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSettings, coerce, SETTINGS } from '../electron/services/settings.cjs';

// Minimal stand-in for JsonStore: dotted get/set over a plain object, no disk.
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
  };
}

const schema = {
  'app.flag': { type: 'bool', default: true },
  'app.name': { type: 'string', default: '' },
  'app.count': { type: 'int', default: 5, min: 1, max: 10 },
  'app.ratio': { type: 'float', default: 1.5, min: 0, max: 2 },
  'app.mode': { type: 'enum', values: ['a', 'b'], default: 'a' },
  'app.dir': { type: 'path', default: '/tmp' },
  'app.tags': { type: 'list', default: [] },
  'app.blob': { type: 'object', default: {} },
  'app.port': {
    type: 'int',
    default: 80,
    validate: (v) => (v === 22 ? 'port 22 is reserved' : true),
  },
};

describe('coerce', () => {
  it('accepts well-typed values', () => {
    expect(coerce(schema['app.flag'], false)).toEqual({ ok: true, value: false });
    expect(coerce(schema['app.name'], 'x')).toEqual({ ok: true, value: 'x' });
    expect(coerce(schema['app.count'], 7)).toEqual({ ok: true, value: 7 });
    expect(coerce(schema['app.mode'], 'b')).toEqual({ ok: true, value: 'b' });
    expect(coerce(schema['app.tags'], ['a', 'b'])).toEqual({
      ok: true,
      value: ['a', 'b'],
    });
  });

  it('rejects wrong types without coercing', () => {
    expect(coerce(schema['app.flag'], 'true').ok).toBe(false);
    expect(coerce(schema['app.count'], '7').ok).toBe(false);
    expect(coerce(schema['app.name'], 7).ok).toBe(false);
    expect(coerce(schema['app.blob'], []).ok).toBe(false);
    expect(coerce(schema['app.blob'], null).ok).toBe(false);
  });

  it('enforces int-ness and bounds', () => {
    expect(coerce(schema['app.count'], 7.5).ok).toBe(false);
    expect(coerce(schema['app.count'], 0).ok).toBe(false);
    expect(coerce(schema['app.count'], 11).ok).toBe(false);
    expect(coerce(schema['app.count'], 1).ok).toBe(true);
    expect(coerce(schema['app.count'], 10).ok).toBe(true);
    expect(coerce(schema['app.ratio'], 1.25).ok).toBe(true);
    expect(coerce(schema['app.ratio'], 2.5).ok).toBe(false);
  });

  it('rejects NaN and Infinity', () => {
    expect(coerce(schema['app.ratio'], NaN).ok).toBe(false);
    expect(coerce(schema['app.ratio'], Infinity).ok).toBe(false);
  });

  it('rejects values outside an enum', () => {
    const result = coerce(schema['app.mode'], 'c');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/a, b/);
  });

  it('rejects empty paths and non-string list entries', () => {
    expect(coerce(schema['app.dir'], '   ').ok).toBe(false);
    expect(coerce(schema['app.tags'], ['a', '']).ok).toBe(false);
    expect(coerce(schema['app.tags'], ['a', 3]).ok).toBe(false);
  });
});

describe('read', () => {
  it('returns defaults for unset keys', () => {
    const s = createSettings({ store: fakeStore(), schema });
    expect(s.read()['app.flag']).toBe(true);
    expect(s.read()['app.count']).toBe(5);
  });

  it('resolves function defaults lazily', () => {
    const spy = vi.fn(() => '/from/machine');
    const s = createSettings({
      store: fakeStore(),
      schema,
      defaults: { 'app.dir': spy },
    });
    expect(s.get('app.dir')).toBe('/from/machine');
    expect(spy).toHaveBeenCalled();
  });

  it('prefers stored values over defaults', () => {
    const s = createSettings({
      store: fakeStore({ settings: { app: { count: 9 } } }),
      schema,
    });
    expect(s.get('app.count')).toBe(9);
  });

  it('falls back to the default when the stored value is invalid', () => {
    // A store hand-edited into a bad state must not propagate garbage.
    const s = createSettings({
      store: fakeStore({ settings: { app: { count: 'nine', mode: 'zzz' } } }),
      schema,
    });
    expect(s.get('app.count')).toBe(5);
    expect(s.get('app.mode')).toBe('a');
  });

  it('returns undefined for keys outside the schema', () => {
    const s = createSettings({ store: fakeStore(), schema });
    expect(s.get('app.nope')).toBeUndefined();
  });
});

describe('write', () => {
  let store;
  let s;
  let effect;

  beforeEach(() => {
    store = fakeStore();
    effect = vi.fn();
    s = createSettings({ store, schema, effects: { 'app.flag': effect } });
  });

  it('persists valid keys and reports them', () => {
    const result = s.write({ 'app.flag': false, 'app.count': 3 });
    expect(result.ok).toBe(true);
    expect(result.applied.sort()).toEqual(['app.count', 'app.flag']);
    expect(store.get('settings.app.flag')).toBe(false);
    expect(store.get('settings.app.count')).toBe(3);
  });

  it('drops unknown keys and says so', () => {
    const result = s.write({ 'app.nope': 1 });
    expect(result.ok).toBe(false);
    expect(result.applied).toEqual([]);
    expect(result.rejected).toEqual([{ key: 'app.nope', reason: 'unknown setting' }]);
    expect(store.get('settings.app.nope')).toBeUndefined();
  });

  it('leaves the store untouched for a rejected value', () => {
    s.write({ 'app.count': 3 });
    const result = s.write({ 'app.count': 99 });
    expect(result.ok).toBe(false);
    expect(store.get('settings.app.count')).toBe(3);
  });

  it('applies the valid half of a mixed patch', () => {
    const result = s.write({ 'app.count': 4, 'app.mode': 'nope' });
    expect(result.applied).toEqual(['app.count']);
    expect(result.rejected).toHaveLength(1);
    expect(store.get('settings.app.count')).toBe(4);
  });

  it('honours a custom validate hook', () => {
    const result = s.write({ 'app.port': 22 });
    expect(result.ok).toBe(false);
    expect(result.rejected[0].reason).toBe('port 22 is reserved');
    expect(store.get('settings.app.port')).toBeUndefined();
  });

  it('runs an effect once per applied key, with the new value', () => {
    s.write({ 'app.flag': false });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(effect.mock.calls[0][0]).toBe(false);
  });

  it('does not run an effect for a rejected key', () => {
    s.write({ 'app.flag': 'nope' });
    expect(effect).not.toHaveBeenCalled();
  });

  it('gives effects the fully-applied state, not a half-applied one', () => {
    const seen = [];
    const multi = createSettings({
      store: fakeStore(),
      schema,
      effects: { 'app.count': (_v, all) => seen.push(all['app.mode']) },
    });
    multi.write({ 'app.count': 2, 'app.mode': 'b' });
    expect(seen).toEqual(['b']);
  });

  it('reports a throwing effect without unwinding the value', () => {
    const boom = createSettings({
      store,
      schema,
      effects: {
        'app.flag': () => {
          throw new Error('login item failed');
        },
      },
    });
    const result = boom.write({ 'app.flag': false });
    expect(result.ok).toBe(false);
    expect(result.rejected).toEqual([{ key: 'app.flag', reason: 'login item failed' }]);
    expect(store.get('settings.app.flag')).toBe(false);
  });

  it('rejects a non-object patch', () => {
    expect(s.write(null).ok).toBe(false);
    expect(s.write([1, 2]).ok).toBe(false);
    expect(s.write('nope').ok).toBe(false);
  });
});

describe('migrateLegacy', () => {
  const legacySchema = {
    'sites.dir': { type: 'path', default: '/default' },
    'app.startAtLogin': { type: 'bool', default: false },
    'db.user': { type: 'string', default: 'root' },
  };

  it('copies legacy flat keys onto their namespaced homes', () => {
    const store = fakeStore({
      settings: { sitesDir: '/old/sites', startAtLogin: true, dbUser: 'wp' },
    });
    const s = createSettings({ store, schema: legacySchema });
    expect(s.migrateLegacy().sort()).toEqual([
      'app.startAtLogin',
      'db.user',
      'sites.dir',
    ]);
    expect(s.get('sites.dir')).toBe('/old/sites');
    expect(s.get('app.startAtLogin')).toBe(true);
    expect(s.get('db.user')).toBe('wp');
  });

  it('leaves the legacy keys in place so a downgrade still reads them', () => {
    const store = fakeStore({ settings: { sitesDir: '/old/sites' } });
    createSettings({ store, schema: legacySchema }).migrateLegacy();
    expect(store.get('settings.sitesDir')).toBe('/old/sites');
  });

  it('is idempotent and never clobbers a newer value', () => {
    const store = fakeStore({ settings: { sitesDir: '/old/sites' } });
    const s = createSettings({ store, schema: legacySchema });
    s.migrateLegacy();
    s.write({ 'sites.dir': '/new/sites' });
    expect(s.migrateLegacy()).toEqual([]);
    expect(s.get('sites.dir')).toBe('/new/sites');
  });

  it('skips a legacy value that no longer type-checks', () => {
    const store = fakeStore({ settings: { startAtLogin: 'yes' } });
    const s = createSettings({ store, schema: legacySchema });
    expect(s.migrateLegacy()).toEqual([]);
    expect(s.get('app.startAtLogin')).toBe(false);
  });

  it('does nothing on a fresh store', () => {
    const s = createSettings({ store: fakeStore(), schema: legacySchema });
    expect(s.migrateLegacy()).toEqual([]);
  });
});

// The real schema's sites.dir guard: a path that isn't a usable folder is
// rejected on write, so a typo surfaces inline instead of as a failed site
// creation much later.
describe('sites.dir validation', () => {
  const spec = SETTINGS['sites.dir'];

  it('accepts an existing directory', () => {
    expect(spec.validate(os.tmpdir())).toBe(true);
  });

  it('rejects a path that does not exist', () => {
    expect(spec.validate(path.join(os.tmpdir(), 'wpxen-no-such-dir-xyz'))).toBe(
      'that folder does not exist'
    );
  });

  it('rejects a file', () => {
    const file = path.join(os.tmpdir(), `wpxen-settings-test-${Date.now()}`);
    fs.writeFileSync(file, '');
    try {
      expect(spec.validate(file)).toBe('that path is not a folder');
    } finally {
      fs.unlinkSync(file);
    }
  });

  it('rejects it through write(), leaving the store untouched', () => {
    const store = fakeStore();
    const s = createSettings({ store });
    const result = s.write({ 'sites.dir': '/nope/not/here' });
    expect(result.ok).toBe(false);
    expect(result.rejected[0]).toMatchObject({ key: 'sites.dir' });
    expect(store.get('settings.sites.dir', undefined)).toBeUndefined();
  });
});
