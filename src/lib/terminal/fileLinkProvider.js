import { extractFileCandidates } from './fileLinks';

// Module-level stat cache so repeated frames don't re-stat the same candidate.
// Keyed by `${rootPath}\0${text}` → Promise<{exists,isDirectory,resolved}>.
const statCache = new Map();
const STAT_CACHE_CAP = 500;

export function clearFileLinkCache() {
  statCache.clear();
}

function statCandidate(rootPath, text) {
  const key = `${rootPath}\0${text}`;
  let promise = statCache.get(key);
  if (!promise) {
    promise = window.electronAPI
      .terminalStatPath(rootPath, text)
      .catch(() => ({ exists: false }));
    if (statCache.size >= STAT_CACHE_CAP) statCache.clear();
    statCache.set(key, promise);
  }
  return promise;
}

// An xterm ILinkProvider that turns validated file paths in terminal output
// into Cmd+click links opening the file in the editor at line:col.
//   opts.getRootPath() → the site root to resolve/confine against
//   opts.onOpen(resolved, line, col, isDirectory)
export function createFileLinkProvider(term, opts) {
  return {
    provideLinks(bufferLineNumber, callback) {
      const rootPath = opts.getRootPath();
      if (!rootPath) return callback(undefined);
      const line = term.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) return callback(undefined);
      const text = line.translateToString(true);
      const candidates = extractFileCandidates(text);
      if (candidates.length === 0) return callback(undefined);

      Promise.all(
        candidates.map(async (c) => {
          const stat = await statCandidate(rootPath, c.text);
          if (!stat?.exists) return null;
          return {
            // xterm ranges are 1-based and inclusive on both ends.
            range: {
              start: { x: c.start + 1, y: bufferLineNumber },
              end: { x: c.end, y: bufferLineNumber },
            },
            text: c.text,
            activate: (event) => {
              if (!event.metaKey) return;
              opts.onOpen(stat.resolved, c.line, c.col, stat.isDirectory);
            },
          };
        })
      ).then(
        (links) => {
          const valid = links.filter(Boolean);
          callback(valid.length > 0 ? valid : undefined);
        },
        () => callback(undefined)
      );
    },
  };
}
