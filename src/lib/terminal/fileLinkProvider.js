import { extractFileCandidates } from './fileLinks';
import { createLinkResolver } from './linkResolver';

// An xterm ILinkProvider that turns validated file paths in terminal output
// into Cmd+click links opening the file in the editor at line:col.
//   opts.getRootPath() → the site root to resolve/confine against
//   opts.onOpen(resolved, line, col, isDirectory)
//
// Each provider owns its resolver (and therefore its stat cache) for the life
// of its terminal, the way Superset's TerminalLinkManager does — the cache
// survives re-registration but never outlives the terminal. Call dispose()
// alongside the registration's dispose().
export function createFileLinkProvider(term, opts) {
  const resolver = createLinkResolver((text) =>
    window.electronAPI.terminalStatPath(opts.getRootPath(), text)
  );

  return {
    dispose() {
      resolver.clear();
    },

    provideLinks(bufferLineNumber, callback) {
      if (!opts.getRootPath()) return callback(undefined);
      const line = term.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) return callback(undefined);
      const text = line.translateToString(true);
      const candidates = extractFileCandidates(text);
      if (candidates.length === 0) return callback(undefined);

      Promise.all(
        candidates.map(async (c) => {
          const hit = await resolver.resolve(c.text);
          if (!hit) return null;
          return {
            // xterm ranges are 1-based and inclusive on both ends.
            range: {
              start: { x: c.start + 1, y: bufferLineNumber },
              end: { x: c.end, y: bufferLineNumber },
            },
            text: c.text,
            activate: (event) => {
              if (!event.metaKey) return;
              opts.onOpen(hit.resolved, c.line, c.col, hit.isDirectory);
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
