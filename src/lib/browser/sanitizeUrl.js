// What a user types in the address bar isn't a URL yet: `wpxen.test` is a
// host, `localhost:8025` is an insecure host, and `why is php slow` is a search.
//
// Deliberately duplicated in electron/services/browser.cjs — the main process
// sanitizes again before loadURL(), since a URL can also arrive from IPC.
// Keep the two in sync.
export function sanitizeUrl(url) {
  const value = String(url ?? '').trim();
  if (!value) return 'about:blank';
  if (/^https?:\/\//i.test(value) || value.startsWith('about:')) return value;
  if (/^(localhost|127\.0\.0\.1)(:|\/|$)/.test(value)) return `http://${value}`;
  const search = `https://www.google.com/search?q=${encodeURIComponent(value)}`;
  // Any other scheme (javascript:, mailto:, file:, data:…) is never a host.
  // Prefixing https:// would mangle it into a URL that won't load at all, or —
  // `https://mailto:a@b.c` — credentials for another host. host:port
  // (wpxen.test:8443) is a host, not a scheme.
  if (/^[a-z][a-z0-9+.-]*:(?!\d+(\/|$))/i.test(value)) return search;
  // A dot means they meant a host; no dot means they meant a search. And it
  // has to come out a real URL, or it was never a host either.
  if (value.includes('.') && !value.includes(' ')) {
    const candidate = `https://${value}`;
    try {
      new URL(candidate);
      return candidate;
    } catch {
      return search;
    }
  }
  return search;
}

// Address-bar presentation: hide about:blank entirely and drop the bare
// trailing slash so "https://wpxen.test/" reads as "https://wpxen.test".
export function displayUrl(url) {
  if (!url || url === 'about:blank') return '';
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
