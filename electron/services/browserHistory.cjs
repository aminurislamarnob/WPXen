'use strict';

// Browsing history for the in-app browser's address-bar autocomplete.
//
// Superset keeps this in SQLite; WPDevPilot has no SQL layer, so it lives in the
// JsonStore under `browser.history` — a most-recent-first list, deduped by URL,
// capped so the store file can't grow without bound.
//
// The array transforms are pure and exported for tests; the store wrappers are
// the thin part.

const STORE_KEY = 'browser.history';
const MAX_ENTRIES = 500;

// Only pages the user could actually navigate back to. A blank tab isn't a
// destination, and non-web schemes never reach the address bar.
function isRecordable(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

// Move an existing URL to the front and bump its visit count, or prepend it.
// Title and favicon are refreshed only when the new visit actually has them —
// a page fires did-stop-loading before its favicon arrives, so an empty value
// must not wipe what a previous visit learned.
function upsertEntry(entries, { url, title, faviconUrl }, now = Date.now()) {
  if (!isRecordable(url)) return entries;

  const previous = entries.find((e) => e.url === url);
  const rest = entries.filter((e) => e.url !== url);

  const entry = {
    url,
    title: title || previous?.title || '',
    faviconUrl: faviconUrl || previous?.faviconUrl || null,
    visitedAt: now,
    visits: (previous?.visits || 0) + 1,
  };

  return [entry, ...rest].slice(0, MAX_ENTRIES);
}

// Rank by how the query matched, then by recency. A host prefix is what people
// mean when they type "wph", so it outranks a match buried in a query string.
function searchEntries(entries, query, limit = 8) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  if (!q) return entries.slice(0, limit);

  const scored = [];
  for (const entry of entries) {
    const url = entry.url.toLowerCase();
    const title = (entry.title || '').toLowerCase();
    // Compare against the URL without its scheme too, so "wpdevpilot" matches
    // "https://wpdevpilot.test" as a prefix rather than a mid-string hit.
    const bare = url.replace(/^https?:\/\/(www\.)?/, '');

    let tier;
    if (bare.startsWith(q) || url.startsWith(q)) tier = 0;
    else if (title.startsWith(q)) tier = 1;
    else if (url.includes(q)) tier = 2;
    else if (title.includes(q)) tier = 3;
    else continue;

    scored.push({ entry, tier });
  }

  scored.sort((a, b) => a.tier - b.tier || b.entry.visitedAt - a.entry.visitedAt);
  return scored.slice(0, limit).map((s) => s.entry);
}

function read(store) {
  const entries = store.get(STORE_KEY, []);
  return Array.isArray(entries) ? entries : [];
}

function record(store, visit) {
  const next = upsertEntry(read(store), visit);
  store.set(STORE_KEY, next);
  return next.length;
}

function search(store, query, limit) {
  return searchEntries(read(store), query, limit);
}

function clear(store) {
  store.set(STORE_KEY, []);
}

module.exports = {
  STORE_KEY,
  MAX_ENTRIES,
  isRecordable,
  upsertEntry,
  searchEntries,
  record,
  search,
  clear,
};
