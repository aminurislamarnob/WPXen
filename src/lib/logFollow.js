// Pure helpers behind the Site Logs viewer's live follow (SiteLogs.jsx). The
// main process (electron/services/logFollow.cjs) pushes `{ entries, size }`
// as a log grows, or `{ reset: true, page }` when it starts over.
//
// Pushes are unfiltered — every level, so the counts can include the hidden
// ones — and the level filter (logView.js) is applied here, before display.

import { hasLevelFilters, visibleLevels } from './logView';

// The follow rule. `state` is `{ atBottom, marker }`: whether the reader is
// at the newest entry (shouldStickToBottom in chatList.js decides, on
// scroll), and whether the New entries marker shows. Returns the next state
// plus `scrollToEnd`, whether the view should move to the newest entry.
//
// Events: `entries` (live entries landed; `added` of them new), `scroll`
// (the reader moved; `atBottom` where to), `jump` (New entries clicked),
// `reset` (a fresh page: Clear, rotation, a burst).
export function followLive(state, event) {
  switch (event.type) {
    case 'entries':
      // Following: go with the log. Reading older entries: hold still, and
      // say there's more — but only when something new arrived, not when
      // the newest entry just gained its trace.
      if (state.atBottom) return { atBottom: true, marker: false, scrollToEnd: true };
      return {
        atBottom: false,
        marker: state.marker || event.added > 0,
        scrollToEnd: false,
      };
    case 'scroll':
      return {
        atBottom: event.atBottom,
        marker: event.atBottom ? false : state.marker,
        scrollToEnd: false,
      };
    case 'jump':
    case 'reset':
      // A reset's old position means nothing in the new file, so it starts
      // over at the newest entry, following.
      return { atBottom: true, marker: false, scrollToEnd: true };
    default:
      return { ...state, scrollToEnd: false };
  }
}

// Folds pushed entries into the view. Entries are keyed by byte offset: one
// already shown is the newest entry re-read (it may have grown a trace) and
// replaces it in place; the rest are new and go at the bottom. Returns the
// view and how many entries were new.
export function mergeLive(view, { entries, size }) {
  const byOffset = new Map(entries.map((e) => [e.offset, e]));
  const merged = view.entries.map((e) => {
    const update = byOffset.get(e.offset);
    if (!update) return e;
    byOffset.delete(e.offset);
    return update;
  });
  const fresh = [...byOffset.values()];
  return {
    view: { ...view, entries: [...merged, ...fresh], size: size ?? view.size },
    added: fresh.length,
  };
}

// Where the watcher starts for a freshly loaded page: at the newest entry
// the file held when it was read, of any level (`lastOffset`), not the
// newest one shown — on a filtered page that can be many pages back, and the
// watcher would start over at an unfiltered page instead. Pass the newest
// window read: a filtered load that read further back to find entries ends
// its page there, not at the end of the file.
export function followStart(page) {
  const last = page.entries[page.entries.length - 1];
  return { from: page.lastOffset ?? (last ? last.offset : page.end), end: page.end };
}

// The pushed entries the view shows: those at the filter's visible levels
// on an error log, all of them on the access log, which has no levels.
export function visibleLive(entries, kind, hidden) {
  if (!hasLevelFilters(kind)) return entries;
  const levels = visibleLevels(hidden);
  return entries.filter((e) => levels.includes(e.level));
}

// A push as the view takes it: `data` filtered to what the view shows. A
// reset page is filtered the same way (it keeps its paging, so Load older
// reaches the levels it hides).
export function liveForView(data, kind, hidden) {
  if (data.reset) {
    return {
      ...data,
      page: { ...data.page, entries: visibleLive(data.page.entries, kind, hidden) },
    };
  }
  return { ...data, entries: visibleLive(data.entries, kind, hidden) };
}

// Adds live entries to the per-level counts (logReader's countLevels
// result: `counts` per level, over the file's first `size` bytes). Every
// level counts, hidden or not. An entry before `countedTo` — anything the
// count already covered, or the newest entry re-read because it grew a
// trace — is already in; the rest are new. No counts (the access log, or not
// loaded yet) stays as it is.
export function countLive(tally, entries) {
  if (!tally?.counts) return tally;
  const from = tally.countedTo ?? tally.size;
  const fresh = entries.filter((e) => e.offset >= from && e.level in tally.counts);
  if (!fresh.length) return tally;
  const counts = { ...tally.counts };
  for (const e of fresh) counts[e.level]++;
  const countedTo = Math.max(...fresh.map((e) => e.offset)) + 1;
  return { ...tally, counts, countedTo };
}
