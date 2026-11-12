// Pure helpers behind the Site Logs viewer (SiteLogs.jsx). A "view" is the
// page shape electron/services/logReader.cjs returns — { path, size,
// entries, pageStart, atStart } — grown upwards by Load older.

// Puts an older page above the entries already shown. Entries are keyed by
// byte offset; anything at or past the first one shown is already on screen,
// so an overlapping page can never show an entry twice.
export function prependOlder(view, older) {
  const firstShown = view.entries.length ? view.entries[0].offset : Infinity;
  const fresh = older.entries.filter((e) => e.offset < firstShown);
  return {
    ...view,
    entries: [...fresh, ...view.entries],
    pageStart: older.pageStart,
    atStart: older.atStart,
  };
}

export function formatLogSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// The line above search results. A batch (logReader's searchLog) has the
// page shape, so Load more matches grows it with prependOlder like Load
// older does; `atStart` false means older matches may remain.
export function matchSummary(result) {
  if (!result) return '';
  const n = result.entries.length;
  if (n === 0) return 'No matches';
  const count = `${n} ${n === 1 ? 'match' : 'matches'}`;
  return result.atStart ? count : `${count} so far — more in older entries`;
}

// ── Level filters ─────────────────────────────────────────────────────────
// The levels logReader.cjs normalises to, in the order the filter shows
// them. The access log has no levels, so it gets no filter.
export const FILTER_LEVELS = ['fatal', 'warning', 'notice', 'deprecated', 'other'];
export const DEFAULT_HIDDEN_LEVELS = ['deprecated'];

// Which levels are hidden, remembered per viewer in localStorage — a
// convenience, not a setting. Stored as the hidden set so that a level added
// later starts out visible. One choice covers all three error logs.
export const LOG_LEVEL_FILTER_KEY = 'wpxen.logLevelFilter';

export const hasLevelFilters = (kind) => kind !== 'nginx-access';

export function visibleLevels(hidden) {
  return FILTER_LEVELS.filter((level) => !hidden.includes(level));
}

// The `levels` a whole-log search takes: the visible ones on an error log,
// so a filtered view searches only what it shows; none on the access log,
// which has no levels.
export function searchLevels(kind, hidden) {
  return hasLevelFilters(kind) ? visibleLevels(hidden) : undefined;
}

export function toggleHiddenLevel(hidden, level) {
  return hidden.includes(level)
    ? hidden.filter((l) => l !== level)
    : FILTER_LEVELS.filter((l) => l === level || hidden.includes(l));
}

// A stored value that isn't a list (missing, corrupted) falls back to the
// default; names that aren't levels are dropped.
export function parseHiddenLevels(raw) {
  try {
    const value = JSON.parse(raw);
    if (Array.isArray(value)) return FILTER_LEVELS.filter((l) => value.includes(l));
  } catch {
    // fall through
  }
  return [...DEFAULT_HIDDEN_LEVELS];
}

export function readHiddenLevels() {
  try {
    return parseHiddenLevels(localStorage.getItem(LOG_LEVEL_FILTER_KEY));
  } catch {
    return [...DEFAULT_HIDDEN_LEVELS];
  }
}

export function saveHiddenLevels(hidden) {
  try {
    localStorage.setItem(LOG_LEVEL_FILTER_KEY, JSON.stringify(hidden));
  } catch {
    // storage unavailable — the choice lasts this session only
  }
}
