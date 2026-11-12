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
