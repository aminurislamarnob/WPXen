'use strict';

// Only ever hand these schemes to shell.openExternal — never file:// or a
// custom URL handler that a tampered store, or a page loaded in the in-app
// browser, could smuggle in.
//
// Shared by ipc.cjs (site quick actions) and services/browser.cjs (the in-app
// browser's "open in default browser" context-menu items) so there is exactly
// one path out of the app.
function openExternalSafely(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      // Required here, not at module scope: services/browser.cjs pulls this in,
      // and the test suite runs under ELECTRON_SKIP_BINARY_DOWNLOAD=1 where a
      // top-level require throws on import.
      require('electron').shell.openExternal(url);
      return true;
    }
  } catch {
    // fall through
  }
  return false;
}

module.exports = { openExternalSafely };
