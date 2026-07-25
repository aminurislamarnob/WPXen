import { WebglAddon } from '@xterm/addon-webgl';

// Once WebGL fails on any terminal, skip it for all subsequent ones (VS Code
// pattern) — a failure is almost always the GPU/driver, not this instance.
let webglFailed = false;

// Attach the WebGL renderer to an already-opened terminal, deferred to rAF to
// avoid racing xterm's post-open viewport sync. On context loss it disposes
// itself and falls back to the DOM renderer. Returns a cleanup function.
export function attachWebgl(term) {
  let addon = null;
  const rafId = requestAnimationFrame(() => {
    if (webglFailed) return;
    try {
      addon = new WebglAddon();
      addon.onContextLoss(() => {
        try {
          addon?.dispose();
        } catch {
          /* ignore */
        }
        addon = null;
        webglFailed = true;
        term.refresh(0, term.rows - 1);
      });
      term.loadAddon(addon);
    } catch {
      webglFailed = true;
      addon = null;
    }
  });

  return () => {
    cancelAnimationFrame(rafId);
    try {
      addon?.dispose();
    } catch {
      /* ignore */
    }
    addon = null;
  };
}
