// A way for a page to run a one-line command in a new Floating Workspace
// terminal — Tasks uses it for `gh auth login`, which is interactive and needs
// a real terminal. The mounted FloatingWorkspace registers itself as the
// runner; with none registered (the workspace is turned off in Settings),
// `runInFloatingTerminal` resolves null and the caller falls back to telling
// the user what to type.

let runner = null;

export function registerFloatingRunner(fn) {
  runner = fn;
  return () => {
    if (runner === fn) runner = null;
  };
}

export function hasFloatingRunner() {
  return runner !== null;
}

// Resolves the new Session's id, or null when no terminal could be opened.
export async function runInFloatingTerminal({ command, cwd } = {}) {
  if (!runner) return null;
  try {
    return (await runner({ command, cwd })) || null;
  } catch {
    // The runner reports its own failure in the workspace; the caller just
    // learns nothing was started.
    return null;
  }
}
