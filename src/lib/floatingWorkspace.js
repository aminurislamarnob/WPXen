// Floating Workspace model — the pure half of the floating panel: its tab list
// and how a new tab picks its directory. No React, no DOM, no IPC, so the
// rules unit-test in plain Node; FloatingWorkspace.jsx is the glue.

// ── Tabs ─────────────────────────────────────────────────────────────────────
// A tab is one of:
//   { kind: 'terminal', id, sessionId, cwd }
// (browser and note tabs join in their own tickets). `id` is the tab's own
// identity, separate from the sessionId, so a Restart can swap the Session
// underneath without the tab moving or losing focus.

export const EMPTY_WORKSPACE = Object.freeze({ tabs: [], activeId: null });

let seq = 0;
export function newTabId(kind) {
  seq += 1;
  return `${kind}:${Date.now().toString(36)}:${seq}`;
}

export function workspaceReducer(state, action) {
  switch (action.type) {
    case 'add': {
      // A new tab goes to the end of the strip and takes focus.
      return { tabs: [...state.tabs, action.tab], activeId: action.tab.id };
    }
    case 'close': {
      const i = state.tabs.findIndex((t) => t.id === action.id);
      if (i === -1) return state;
      const tabs = state.tabs.filter((t) => t.id !== action.id);
      if (state.activeId !== action.id) return { ...state, tabs };
      // Closing the focused tab focuses its right-hand neighbour, else the
      // left-hand one — the usual tab-strip rule.
      const next = tabs[i] || tabs[i - 1] || null;
      return { tabs, activeId: next ? next.id : null };
    }
    case 'activate': {
      if (!state.tabs.some((t) => t.id === action.id)) return state;
      return { ...state, activeId: action.id };
    }
    case 'update': {
      if (!state.tabs.some((t) => t.id === action.id)) return state;
      return {
        ...state,
        tabs: state.tabs.map((t) => (t.id === action.id ? { ...t, ...action.patch } : t)),
      };
    }
    // A Session the main process no longer lists (dismissed elsewhere, or
    // reaped) takes its tab with it.
    case 'prune': {
      const live = new Set(action.sessionIds);
      const gone = state.tabs.filter(
        (t) => t.kind === 'terminal' && !live.has(t.sessionId)
      );
      return gone.reduce(
        (s, t) => workspaceReducer(s, { type: 'close', id: t.id }),
        state
      );
    }
    default:
      return state;
  }
}

export function activeTab(state) {
  return state.tabs.find((t) => t.id === state.activeId) || null;
}

// ── Context ──────────────────────────────────────────────────────────────────
// A new tab opens where the user is: on a Site's page, or that Site's Agents
// view, the Site's webroot (and its URL, for browser tabs); anywhere else the
// configured Terminal Directory. Resolved once, at creation — an open tab never
// follows later navigation.

const SITE_ROUTE = /^\/(?:sites|agents)\/([^/]+)/;

export function siteIdFromPath(pathname) {
  const m = SITE_ROUTE.exec(pathname || '');
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

export function resolveContext({ pathname, sites = [], terminalDirectory = '~' }) {
  const id = siteIdFromPath(pathname);
  const site = id ? sites.find((s) => s.id === id) : null;
  if (site && site.path) {
    return { siteId: site.id, cwd: site.path, url: site.url || null };
  }
  return { siteId: null, cwd: terminalDirectory || '~', url: null };
}

// ── Labels ───────────────────────────────────────────────────────────────────

// The last path segment, with ~ kept readable: "~" for home, "foo" for
// "/Users/me/Sites/foo".
export function folderName(cwd) {
  const raw = String(cwd || '');
  if (raw && /^\/+$/.test(raw)) return '/';
  const trimmed = raw.replace(/\/+$/, '');
  if (!trimmed || trimmed === '~') return '~';
  return trimmed.split('/').pop();
}

// A terminal tab shows the shell's own title when it set one, else the folder
// it was opened in.
export function terminalTabTitle(tab, session) {
  const title = session?.title?.trim();
  return title || folderName(session?.cwd || tab.cwd);
}

// Whether the minimised launcher should show its attention dot.
export function needsAttention(sessions) {
  return sessions.some((s) => !s.exited && (s.unread || s.state === 'needs-input'));
}
