'use strict';

// Global settings: one schema, one validator, one place for side effects.
//
// Every user preference is declared once in SETTINGS below with its type, its
// default and (optionally) its bounds. The renderer never writes the store
// directly — it sends a patch to `settings-set`, which is validated here, so an
// unknown or malformed key can never reach disk. Side effects (login item,
// MySQL credentials, nginx reloads) hang off the `effects` map injected at
// init, keeping this module free of electron imports and therefore testable.
//
// Values are addressed by dotted key ('app.confirmOnQuit') and persisted under
// the `settings.` prefix in the JsonStore, so `app.confirmOnQuit` lands at
// `settings.app.confirmOnQuit`.

// ─── Schema ────────────────────────────────────────────────────────────────
//
// type: bool | string | int | float | enum | path | list | object
//   int/float accept `min`/`max`; enum requires `values`; list is an array of
//   non-empty strings; object is opaque and must bring its own `validate`.
// default: a literal, or a function resolved lazily at read time (used where
//   the default depends on the machine, e.g. the detected PHP version).
// validate: (value) => true | string   — a string is the rejection reason.

const SETTINGS = {
  // ── Sites ────────────────────────────────────────────────────────────────
  'sites.dir': { type: 'path' },
  // Prefills for the Add Site sheet. These are starting points, not overrides:
  // the sheet still lets any individual site deviate.
  'sites.defaultWpVersion': { type: 'string', default: 'latest' },
  'sites.defaultLocale': { type: 'string', default: 'en_US' },
  'sites.defaultAdminUser': { type: 'string', default: 'admin' },
  // Blank means "derive admin@<site-domain>", which is what the Add Site sheet
  // did before this setting existed.
  'sites.defaultAdminEmail': {
    type: 'string',
    default: '',
    validate: (v) =>
      v === '' || /^[^@\s]+@[^@\s]+$/.test(v) || 'not a valid email address',
  },
  'sites.httpsOnCreate': { type: 'bool', default: false },

  // ── PHP ──────────────────────────────────────────────────────────────────
  'php.defaultVersion': { type: 'string', default: '' },

  // ── App ──────────────────────────────────────────────────────────────────
  'app.startAtLogin': { type: 'bool', default: false },
  // Quitting stops nginx, PHP-FPM and MySQL for every site at once, so the
  // confirmation defaults on.
  'app.confirmOnQuit': { type: 'bool', default: true },
  'app.closeAction': { type: 'enum', values: ['tray', 'quit'], default: 'tray' },

  // ── Appearance ───────────────────────────────────────────────────────────
  // Drives Electron's nativeTheme.themeSource, which forces the renderer's
  // prefers-color-scheme — so the existing `darkMode: 'media'` tokens and the
  // opaque window backdrop both follow it with no CSS changes.
  'appearance.themeMode': {
    type: 'enum',
    values: ['system', 'light', 'dark'],
    default: 'system',
  },

  // Typography, split into two independent blocks the way Superset does.
  // A blank font family means "use the built-in mono stack".
  'appearance.terminal.fontFamily': { type: 'string', default: '' },
  'appearance.terminal.fontSize': { type: 'int', default: 13, min: 8, max: 32 },
  'appearance.terminal.lineHeight': { type: 'float', default: 1.0, min: 0.8, max: 3 },
  'appearance.terminal.letterSpacing': { type: 'float', default: 0, min: -2, max: 5 },
  'appearance.terminal.fontWeight': { type: 'int', default: 400, min: 100, max: 900 },
  'appearance.terminal.ligatures': { type: 'bool', default: false },
  // 0 disables the check; xterm treats 1 as "no enforcement" and 21 as maximum.
  'appearance.terminal.minimumContrast': { type: 'float', default: 1, min: 1, max: 21 },
  'appearance.terminal.cursorStyle': {
    type: 'enum',
    values: ['block', 'bar', 'underline'],
    default: 'block',
  },
  'appearance.terminal.cursorBlink': { type: 'bool', default: true },

  'appearance.editor.fontFamily': { type: 'string', default: '' },
  'appearance.editor.fontSize': { type: 'int', default: 13, min: 8, max: 32 },
  'appearance.editor.lineHeight': { type: 'float', default: 1.5, min: 0.8, max: 3 },
  'appearance.editor.letterSpacing': { type: 'float', default: 0, min: -2, max: 5 },
  'appearance.editor.fontWeight': { type: 'int', default: 400, min: 100, max: 900 },
  'appearance.editor.ligatures': { type: 'bool', default: false },

  // ── External tools ───────────────────────────────────────────────────────
  // 'system' means "whatever macOS opens this with" — the behaviour before
  // these settings existed.
  'tools.editor': {
    type: 'enum',
    values: ['system', 'vscode', 'cursor', 'phpstorm', 'sublime', 'zed', 'custom'],
    default: 'system',
  },
  'tools.editorCustomCommand': { type: 'string', default: '' },
  'tools.terminalApp': {
    type: 'enum',
    values: ['system', 'terminal', 'iterm', 'warp', 'ghostty'],
    default: 'system',
  },

  // ── Agents ───────────────────────────────────────────────────────────────
  // An empty list means "every agent" rather than "none" — a user who has not
  // touched this setting should see the full launcher.
  'agents.enabled': { type: 'list', default: [] },
  // { [agentId]: 'claude --resume' } — overrides the built-in launch command.
  'agents.commands': {
    type: 'object',
    default: {},
    validate: (v) =>
      Object.values(v).every((c) => typeof c === 'string') ||
      'each command must be a string',
  },
  // User-defined agents: [{ id, name, cmd }]
  'agents.custom': {
    type: 'object',
    default: { list: [] },
    validate: (v) =>
      (Array.isArray(v.list) &&
        v.list.every(
          (a) =>
            a &&
            typeof a.id === 'string' &&
            /^[a-z0-9-]+$/.test(a.id) &&
            typeof a.cmd === 'string' &&
            a.cmd.trim().length > 0
        )) ||
      'each agent needs a slug id and a command',
  },

  // ── Database ─────────────────────────────────────────────────────────────
  'db.user': { type: 'string', default: 'root' },
  'db.password': { type: 'string', default: '' },

  // ── Mail ─────────────────────────────────────────────────────────────────
  'mail.catch': { type: 'bool', default: false },
  'mail.autoOpenInbox': { type: 'bool', default: false },

  // ── Services ─────────────────────────────────────────────────────────────
  // Mailpit is in the default set to match the pre-settings behaviour; it is
  // skipped at launch when not installed.
  'services.autoStart': {
    type: 'list',
    default: ['nginx', 'php', 'mysql', 'mailpit'],
    validate: (v) =>
      v.every((n) => ['nginx', 'php', 'mysql', 'mailpit'].includes(n)) ||
      'unknown service name',
  },
  // procman truncates a service log once it passes this size (it rotates by
  // size, not by age — there is no dated-file retention to configure).
  'services.logMaxSizeMb': { type: 'int', default: 5, min: 1, max: 200 },
};

// Legacy flat keys → new namespaced keys. Migrated once on init; the old keys
// are deliberately left in place for one release so downgrading doesn't lose
// data.
const LEGACY_KEYS = {
  sitesDir: 'sites.dir',
  defaultPhpVersion: 'php.defaultVersion',
  startAtLogin: 'app.startAtLogin',
  dbUser: 'db.user',
  dbPassword: 'db.password',
  mailCatch: 'mail.catch',
};

// ─── Validation ────────────────────────────────────────────────────────────

function checkNumber(value, spec, integer) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, reason: `expected a ${integer ? 'whole number' : 'number'}` };
  }
  if (integer && !Number.isInteger(value)) {
    return { ok: false, reason: 'expected a whole number' };
  }
  if (spec.min !== undefined && value < spec.min) {
    return { ok: false, reason: `must be at least ${spec.min}` };
  }
  if (spec.max !== undefined && value > spec.max) {
    return { ok: false, reason: `must be at most ${spec.max}` };
  }
  return { ok: true, value };
}

// Type-checks a single value against its spec. Returns {ok, value} or
// {ok: false, reason}. Deliberately strict: no coercion, because a silently
// coerced '' → 0 is worse than a visible rejection.
function coerce(spec, value) {
  switch (spec.type) {
    case 'bool':
      return typeof value === 'boolean'
        ? { ok: true, value }
        : { ok: false, reason: 'expected true or false' };

    case 'string':
      return typeof value === 'string'
        ? { ok: true, value }
        : { ok: false, reason: 'expected a string' };

    case 'path':
      if (typeof value !== 'string') return { ok: false, reason: 'expected a path' };
      if (!value.trim()) return { ok: false, reason: 'path cannot be empty' };
      return { ok: true, value };

    case 'int':
      return checkNumber(value, spec, true);

    case 'float':
      return checkNumber(value, spec, false);

    case 'enum':
      return spec.values.includes(value)
        ? { ok: true, value }
        : { ok: false, reason: `must be one of: ${spec.values.join(', ')}` };

    case 'list':
      if (!Array.isArray(value)) return { ok: false, reason: 'expected a list' };
      if (!value.every((v) => typeof v === 'string' && v.trim())) {
        return { ok: false, reason: 'list entries must be non-empty strings' };
      }
      return { ok: true, value };

    case 'object':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, reason: 'expected an object' };
      }
      return { ok: true, value };

    default:
      return { ok: false, reason: `unknown setting type '${spec.type}'` };
  }
}

// ─── Instance ──────────────────────────────────────────────────────────────

/**
 * Binds the schema to a store.
 *
 * @param {object} opts.store      JsonStore (needs get/set with dotted paths)
 * @param {object} opts.effects    { [key]: (value, all) => void } run after a
 *                                 key is persisted. Throwing is contained: the
 *                                 value stays written and the error surfaces on
 *                                 the result so the UI can say so.
 * @param {object} opts.defaults   { [key]: value | () => value } machine-derived
 *                                 defaults overriding the schema's.
 * @param {object} opts.schema     override for tests
 */
function createSettings({ store, effects = {}, defaults = {}, schema = SETTINGS }) {
  function specFor(key) {
    return Object.prototype.hasOwnProperty.call(schema, key) ? schema[key] : null;
  }

  function defaultFor(key, spec) {
    const override = Object.prototype.hasOwnProperty.call(defaults, key)
      ? defaults[key]
      : undefined;
    const raw = override !== undefined ? override : spec.default;
    return typeof raw === 'function' ? raw() : raw;
  }

  // Flat dotted map of every known setting, store value or default. Flat rather
  // than nested because that's what the registry-driven UI and the search index
  // both want.
  function read() {
    const out = {};
    for (const [key, spec] of Object.entries(schema)) {
      const stored = store.get(`settings.${key}`, undefined);
      if (stored === undefined) {
        out[key] = defaultFor(key, spec);
        continue;
      }
      // A store hand-edited into an invalid state falls back to the default
      // rather than propagating garbage into the app.
      const checked = coerce(spec, stored);
      out[key] = checked.ok ? checked.value : defaultFor(key, spec);
    }
    return out;
  }

  function get(key) {
    const spec = specFor(key);
    if (!spec) return undefined;
    const stored = store.get(`settings.${key}`, undefined);
    if (stored === undefined) return defaultFor(key, spec);
    const checked = coerce(spec, stored);
    return checked.ok ? checked.value : defaultFor(key, spec);
  }

  /**
   * Validates and persists a patch of dotted keys.
   * @returns {{ok: boolean, applied: string[], rejected: {key, reason}[]}}
   *
   * Rejections are always reported, never silent — a typo'd key that persisted
   * nothing and said nothing would be a debugging trap.
   */
  function write(patch) {
    const applied = [];
    const rejected = [];

    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      return {
        ok: false,
        applied,
        rejected: [{ key: '(patch)', reason: 'expected an object' }],
      };
    }

    for (const [key, value] of Object.entries(patch)) {
      const spec = specFor(key);
      if (!spec) {
        rejected.push({ key, reason: 'unknown setting' });
        continue;
      }
      const checked = coerce(spec, value);
      if (!checked.ok) {
        rejected.push({ key, reason: checked.reason });
        continue;
      }
      if (spec.validate) {
        const verdict = spec.validate(checked.value);
        if (verdict !== true) {
          rejected.push({
            key,
            reason: typeof verdict === 'string' ? verdict : 'invalid value',
          });
          continue;
        }
      }
      store.set(`settings.${key}`, checked.value);
      applied.push(key);
    }

    // Effects run after every value in the patch is persisted, so a handler
    // that reads a sibling key (db.user reading db.password) sees the new
    // state, not a half-applied one.
    const all = read();
    const failed = [];
    for (const key of applied) {
      const effect = effects[key];
      if (!effect) continue;
      try {
        effect(all[key], all);
      } catch (err) {
        failed.push({ key, reason: err?.message || String(err) });
      }
    }

    return {
      ok: rejected.length === 0 && failed.length === 0,
      applied,
      rejected: [...rejected, ...failed],
      settings: all,
    };
  }

  // Copies legacy flat keys onto their namespaced homes. Idempotent: a key
  // already present in its new location is never overwritten, so this can run
  // on every launch.
  function migrateLegacy() {
    const migrated = [];
    for (const [oldKey, newKey] of Object.entries(LEGACY_KEYS)) {
      const spec = specFor(newKey);
      if (!spec) continue;
      if (store.get(`settings.${newKey}`, undefined) !== undefined) continue;
      const legacy = store.get(`settings.${oldKey}`, undefined);
      if (legacy === undefined) continue;
      const checked = coerce(spec, legacy);
      if (!checked.ok) continue;
      store.set(`settings.${newKey}`, checked.value);
      migrated.push(newKey);
    }
    return migrated;
  }

  return { read, get, write, migrateLegacy, schema };
}

module.exports = { SETTINGS, LEGACY_KEYS, createSettings, coerce };
