// Validates terminal link candidates against the filesystem, with TTL caching.
// Mirrors Superset's TerminalLinkResolver (itself adapted from VS Code's
// terminalLinkResolver.ts): results — including negatives — are cached, and a
// single timer flushes the whole cache a fixed delay after the last write, so
// a file created or deleted after a lookup re-links within one TTL window.
//
// Pure apart from the injected `stat` callback, so it unit-tests in plain Node.

// VS Code's / Superset's default. Long enough that a redrawing TUI doesn't
// re-stat every frame, short enough that the tree isn't stale to the eye.
const DEFAULT_TTL_MS = 10_000;

// Skip absurdly long candidates outright — they are never real paths, and
// statting them wastes an IPC round-trip per frame. Matches Superset's
// MAX_RESOLVED_LINK_LENGTH.
const MAX_LINK_LENGTH = 1024;

// `stat(text)` → Promise<{ exists, isDirectory, resolved }>.
// `resolve(text)` → Promise<{ resolved, isDirectory } | null>.
export function createLinkResolver(stat, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const cache = new Map();
  let timer = null;

  const clear = () => {
    cache.clear();
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  // Cache the result and (re)arm the flush. Whole-map expiry on one timer is
  // what Superset/VS Code do — cheaper than per-entry timestamps and it keeps
  // the cache bounded without a size cap.
  const cacheSet = (key, value) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      cache.clear();
      timer = null;
    }, ttlMs);
    cache.set(key, value);
  };

  const resolve = async (text) => {
    if (!text || !text.trim() || text.length > MAX_LINK_LENGTH) return null;
    if (cache.has(text)) return cache.get(text);

    let result = null;
    try {
      const st = await stat(text);
      if (st?.exists) {
        result = { resolved: st.resolved ?? text, isDirectory: !!st.isDirectory };
      }
    } catch {
      result = null;
    }
    cacheSet(text, result);
    return result;
  };

  return { resolve, clear };
}
