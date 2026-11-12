// Pure helpers behind the Site Logs viewer's live follow (SiteLogs.jsx). The
// main process (electron/services/logFollow.cjs) pushes `{ entries, size }`
// as a log grows, or `{ reset: true, page }` when it starts over.

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
