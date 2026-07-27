// What a user types in the address bar isn't a URL yet: `wpdevpilot.test` is a
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
  // A dot means they meant a host; no dot means they meant a search.
  if (value.includes('.') && !value.includes(' ')) return `https://${value}`;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

// Address-bar presentation: hide about:blank entirely and drop the bare
// trailing slash so "https://wpdevpilot.test/" reads as "https://wpdevpilot.test".
export function displayUrl(url) {
  if (!url || url === 'about:blank') return '';
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
