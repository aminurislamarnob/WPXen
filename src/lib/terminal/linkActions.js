// Where a clicked terminal URL goes, after Orca's terminal link actions.
//
//   plain click → the action card (pick a destination, copy the link)
//   ⌘-click     → the default destination (Settings → General → Open links in)
//   ⇧⌘-click    → the other one
//
// Destinations are 'system' (the default browser) and 'app' (a WPXen
// browser tab beside the terminal).

export const DESTINATION_LABEL = {
  system: 'System Browser',
  app: 'WPXen Browser',
};

// The card's two rows: the default destination first (⌘-click), the other
// second (⇧⌘-click).
export function linkDestinations(openLinksIn) {
  const primary = openLinksIn === 'app' ? 'app' : 'system';
  return { primary, alternate: primary === 'app' ? 'system' : 'app' };
}

// → 'actions' for a plain click, a destination for a modified one, or null
// for a click that isn't ours (Ctrl/Alt chords belong to the terminal).
export function resolveLinkClick(event, openLinksIn) {
  if (event.ctrlKey || event.altKey) return null;
  const { primary, alternate } = linkDestinations(openLinksIn);
  if (event.metaKey) return event.shiftKey ? alternate : primary;
  return event.shiftKey ? null : 'actions';
}
