'use strict';

// ── WPXen update check ───────────────────────────────────────────────────────
// Once a day, ask GitHub for WPXen's latest published release and compare it
// with the running version. It only *finds* an update: Download opens the
// release's DMG for this Mac's architecture in the browser, and the user drags
// the new app into Applications.
//
// Why not electron-updater: on macOS it installs through Squirrel.Mac, which
// refuses any update whose code signature doesn't match the running app's
// Developer ID. WPXen builds are ad-hoc signed, so an in-place install would
// find the update and then fail. Revisit once builds are signed and notarized.
//
// State, pushed through `onChange` and read with `getState()`:
//   { current, latest: { version, name, url, publishedAt, download } | null,
//     available, notice, checkedAt, checking, error, dismissed }
// `dismissed` is a version: it hides the Dashboard notice for that release
// only, and a newer one shows again. `onNew` fires once per release (tracked
// in `notified`), which is what the native notification hangs off.
//
// Electron-free; everything with a side effect is a dep.

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Not at launch: services are starting, and the network may not be up yet.
const FIRST_CHECK_DELAY_MS = 2 * 60 * 1000;
// After a failed check (offline, rate-limited): try again sooner than a day.
const RETRY_MS = 60 * 60 * 1000;
const STORE_KEY = 'appUpdates';

const REPO = 'aminurislamarnob/WPXen';
// `/releases/latest` never returns a draft or a prerelease.
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

// 'v0.6.2' → { parts: [0, 6, 2], pre: '' }; null when it isn't a version.
function parseVersion(v) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(
    String(v || '').trim()
  );
  if (!m) return null;
  return { parts: [m[1], m[2] || 0, m[3] || 0].map(Number), pre: m[4] || '' };
}

// -1, 0 or 1, the semver way: 0.6.10 > 0.6.9, and 1.0.0-beta < 1.0.0.
// Anything that doesn't parse sorts lowest, so it never reads as newer.
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) {
    if (x.parts[i] !== y.parts[i]) return x.parts[i] > y.parts[i] ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true }) < 0 ? -1 : 1;
}

// The installer for this Mac, by electron-builder's names:
// `WPXen-<v>-arm64.dmg` for Apple Silicon, `WPXen-<v>.dmg` for Intel. An
// Intel build running under Rosetta is offered the native one. Null when the
// release carries neither; the caller falls back to the release page.
function pickDownload(assets, version, arch) {
  const dmgs = (assets || []).filter((a) => /\.dmg$/i.test(a?.name || ''));
  const named = (name) => dmgs.find((a) => a.name === name);
  const arm = named(`WPXen-${version}-arm64.dmg`);
  const intel = named(`WPXen-${version}.dmg`);
  const pick = arch === 'arm64' ? arm : intel;
  return pick ? pick.browser_download_url : null;
}

// GitHub's release JSON → what the UI needs. Throws on anything that isn't
// a usable published release, so a bad payload reads as a failed check.
function parseRelease(json, arch) {
  if (!json || typeof json !== 'object') throw new Error('empty response');
  if (json.draft || json.prerelease) throw new Error('not a published release');
  const version = String(json.tag_name || '').replace(/^v/, '');
  if (!parseVersion(version)) throw new Error(`unrecognised tag “${json.tag_name}”`);
  return {
    version,
    name: json.name || `v${version}`,
    url: json.html_url || `${RELEASES_PAGE}/tag/v${version}`,
    publishedAt: json.published_at || null,
    download: pickDownload(json.assets, version, arch),
  };
}

function createAppUpdateChecker(deps) {
  const {
    currentVersion, // the running app's version, e.g. '0.6.2'
    fetchLatest, // async () => GitHub release JSON; rejects on failure
    arch = process.arch, // 'arm64' | 'x64': which DMG to offer
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
    latest: saved.latest && parseVersion(saved.latest.version) ? saved.latest : null,
    checkedAt: saved.checkedAt || null,
    checking: false,
    error: null,
    dismissed: saved.dismissed || null,
  };
  let notified = saved.notified || null;
  let inFlight = null;
  let timer = null;

  const persist = () =>
    store.set(STORE_KEY, {
      latest: state.latest,
      checkedAt: state.checkedAt,
      dismissed: state.dismissed,
      notified,
    });

  // Derived each time rather than stored, so updating WPXen itself (a new
  // `currentVersion`) clears the notice without another check.
  const view = () => {
    const available =
      !!state.latest && compareVersions(state.latest.version, currentVersion) > 0;
    return {
      ...state,
      current: currentVersion,
      available,
      notice: available && state.dismissed !== state.latest.version,
    };
  };
  const emit = (patch) => {
    state = { ...state, ...patch };
    onChange(view());
  };

  function check() {
    if (inFlight) return inFlight;
    emit({ checking: true, error: null });
    inFlight = (async () => {
      try {
        const latest = parseRelease(await fetchLatest(), arch);
        emit({ latest, checkedAt: now(), checking: false, error: null });
      } catch (err) {
        emit({
          checking: false,
          error: `Couldn’t check for updates (${firstLine(err)}).`,
        });
      }
      const v = view();
      const fresh = v.available && notified !== v.latest.version;
      if (fresh) notified = v.latest.version;
      persist();
      if (fresh) onNew(v.latest);
      return v;
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
    // Hide the Dashboard notice for the release on offer now.
    dismiss() {
      if (state.latest) emit({ dismissed: state.latest.version });
      persist();
      return view();
    },
  };
}

function firstLine(err) {
  const text = String(err?.message || err || 'unknown error').trim();
  return text.split('\n').find((l) => l.trim()) || 'unknown error';
}

module.exports = {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  RETRY_MS,
  STORE_KEY,
  LATEST_RELEASE_API,
  RELEASES_PAGE,
  parseVersion,
  compareVersions,
  pickDownload,
  parseRelease,
  createAppUpdateChecker,
};
