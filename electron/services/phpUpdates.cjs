'use strict';

// ── PHP update check ─────────────────────────────────────────────────────────
// Once a day, refresh Homebrew's index (`brew update`) and ask which installed
// PHP formulae have a newer release (`brew outdated`). Without the refresh,
// `outdated` only knows releases Homebrew happened to fetch for some other
// command, so a user who never runs brew would never hear about one.
//
// It only *finds* updates. Installing one is still the user's click on the
// PHP page (php.updatePhpVersion → `brew upgrade`).
//
// State, pushed through `onChange` and read with `getState()`:
//   { updates: [{ version, formula, installed, latest }], notice: the subset
//     the Dashboard still shows, checkedAt, checking, error,
//     dismissed: { [formula]: latest } }
// `dismissed` hides the Dashboard notice for that release only; a newer one
// shows again. `onNew` fires once per release (tracked in `notified`), which is
// what the native notification hangs off.
//
// Electron-free; everything with a side effect is a dep.

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Not at launch: services are starting and `brew update` is network-bound.
const FIRST_CHECK_DELAY_MS = 2 * 60 * 1000;
// After a failed check (offline, brew busy): try again sooner than a day.
const RETRY_MS = 60 * 60 * 1000;
const STORE_KEY = 'phpUpdates';

// Installed versions × outdated formulae → the updates to offer. Pure.
// A pinned formula is skipped: `brew upgrade` refuses it, so the button would
// only ever fail. So is a rebuild of the same PHP release.
function findPhpUpdates(installed, outdated) {
  const byName = new Map();
  for (const f of outdated || []) {
    if (!f || f.pinned) continue;
    if (f.name) byName.set(f.name, f);
    if (f.full_name) byName.set(f.full_name, f);
  }
  const updates = [];
  for (const { version, formula } of installed || []) {
    const f = byName.get(formula);
    if (!f || !f.current_version) continue;
    const installedVersions = f.installed_versions || [];
    const current = cleanVersion(installedVersions[installedVersions.length - 1]) || null;
    const latest = cleanVersion(f.current_version);
    // A Homebrew rebuild (8.4.15_1 → 8.4.15_2) is no new PHP release; the PHP
    // page's Update button still offers it, but it isn't announced.
    if (current && current === latest) continue;
    updates.push({ version, formula, installed: current, latest });
  }
  return updates.sort((a, b) =>
    a.version.localeCompare(b.version, undefined, { numeric: true })
  );
}

// '8.4.15_1' → '8.4.15': the `_n` is Homebrew's rebuild number, not PHP's.
function cleanVersion(v) {
  return v ? String(v).replace(/_\d+$/, '') : v;
}

// The updates the Dashboard should still show. Pure.
function undismissed(state) {
  const dismissed = state.dismissed || {};
  return (state.updates || []).filter((u) => dismissed[u.formula] !== u.latest);
}

function createPhpUpdateChecker(deps) {
  const {
    refreshIndex, // async () => void; rejects when offline
    listInstalled, // () => [{ version, formula }]
    listOutdated, // async () => brew outdated formulae
    enabled = () => true, // the background check's setting
    store, // { get(key, def), set(key, value) }
    onChange = () => {},
    onNew = () => {},
    now = () => Date.now(),
    setTimer = (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    },
    clearTimer = clearTimeout,
  } = deps;

  const saved = store.get(STORE_KEY, {}) || {};
  let state = {
    updates: Array.isArray(saved.updates) ? saved.updates : [],
    checkedAt: saved.checkedAt || null,
    checking: false,
    error: null,
    dismissed: saved.dismissed || {},
  };
  let notified = saved.notified || {};
  let inFlight = null;
  let timer = null;

  const persist = () =>
    store.set(STORE_KEY, {
      updates: state.updates,
      checkedAt: state.checkedAt,
      dismissed: state.dismissed,
      notified,
    });

  const view = () => ({ ...state, notice: undismissed(state) });
  const emit = (patch) => {
    state = { ...state, ...patch };
    onChange(view());
  };

  // `refresh: false` skips `brew update` — right after an upgrade, the index
  // is already current and only the installed side changed.
  function check({ refresh = true } = {}) {
    if (inFlight) return inFlight;
    emit({ checking: true });
    inFlight = (async () => {
      let error = null;
      let refreshed = false;
      if (refresh) {
        try {
          await refreshIndex();
          refreshed = true;
        } catch (err) {
          // Still worth reading the local index: it may know of a release.
          error = `Couldn’t refresh Homebrew (${firstLine(err)}).`;
        }
      }
      let updates = state.updates;
      try {
        updates = findPhpUpdates(listInstalled(), await listOutdated());
      } catch (err) {
        error = error || `Couldn’t check for PHP updates (${firstLine(err)}).`;
      }

      // Keep only bookkeeping for releases still on offer.
      const live = new Set(updates.map((u) => `${u.formula}@${u.latest}`));
      const keep = (map) =>
        Object.fromEntries(
          Object.entries(map).filter(([formula, v]) => live.has(`${formula}@${v}`))
        );
      const fresh = updates.filter((u) => notified[u.formula] !== u.latest);
      notified = {
        ...keep(notified),
        ...Object.fromEntries(fresh.map((u) => [u.formula, u.latest])),
      };

      emit({
        updates,
        // Only a real refresh counts: a failed one retries within the hour.
        checkedAt: refreshed ? now() : state.checkedAt,
        checking: false,
        error,
        dismissed: keep(state.dismissed),
      });
      persist();
      if (fresh.length) onNew(fresh);
      return view();
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function schedule(delay) {
    clearTimer(timer);
    const due = state.checkedAt ? state.checkedAt + CHECK_INTERVAL_MS - now() : 0;
    timer = setTimer(
      async () => {
        let failed = false;
        if (enabled()) {
          await check().catch(() => {});
          failed = !!state.error;
        }
        schedule(failed ? RETRY_MS : undefined);
      },
      delay ?? Math.max(FIRST_CHECK_DELAY_MS, due)
    );
  }

  return {
    start: () => schedule(),
    stop() {
      clearTimer(timer);
      timer = null;
    },
    check,
    getState: view,
    // Hide the Dashboard notice for the releases on offer now.
    dismiss() {
      emit({
        dismissed: {
          ...state.dismissed,
          ...Object.fromEntries(state.updates.map((u) => [u.formula, u.latest])),
        },
      });
      persist();
      return view();
    },
  };
}

function firstLine(err) {
  const text = String(err?.stderr || err?.message || err || 'unknown error').trim();
  return text.split('\n').find((l) => l.trim()) || 'unknown error';
}

module.exports = {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  RETRY_MS,
  STORE_KEY,
  findPhpUpdates,
  cleanVersion,
  undismissed,
  createPhpUpdateChecker,
};
