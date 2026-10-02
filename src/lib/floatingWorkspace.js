// Floating Workspace model — the pure half of the floating panel: its tab list
// and how a new tab picks its directory. No React, no DOM, no IPC, so the
// rules unit-test in plain Node; FloatingWorkspace.jsx is the glue.

// ── Tabs ─────────────────────────────────────────────────────────────────────
// A tab is one of:
//   { kind: 'terminal', id, sessionId, cwd }
//   { kind: 'browser', id, url }   — `id` doubles as the webview cache key
// (note tabs join in their own ticket). `id` is the tab's own identity,
// separate from the sessionId, so a Restart can swap the Session underneath
// without the tab moving or losing focus.

export const EMPTY_WORKSPACE = Object.freeze({ tabs: [], activeId: null });

let seq = 0;
// Ids are prefixed `floating-…`: a browser tab's id is its key in the webview
// cache, which the Agents pane shares, and its keys are `browser:<n>`.
export function newTabId(kind) {
  seq += 1;
  return `floating-${kind}:${Date.now().toString(36)}:${seq}`;
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
    // Drag-to-reorder: move a tab to `index` in the strip. Focus stays put.
    case 'move': {
      const from = state.tabs.findIndex((t) => t.id === action.id);
      if (from === -1) return state;
      const to = Math.max(0, Math.min(action.index, state.tabs.length - 1));
      if (from === to) return state;
      const tabs = [...state.tabs];
      const [tab] = tabs.splice(from, 1);
      tabs.splice(to, 0, tab);
      return { ...state, tabs };
    }
    // ⌃Tab / ⌃⇧Tab: step through the strip, wrapping at either end.
    case 'cycle': {
      const n = state.tabs.length;
      if (n < 2) return state;
      const i = Math.max(
        0,
        state.tabs.findIndex((t) => t.id === state.activeId)
      );
      const next = state.tabs[(((i + action.delta) % n) + n) % n];
      return { ...state, activeId: next.id };
    }
    // Replace the whole workspace — restoring a saved layout at launch.
    case 'hydrate': {
      return action.state;
    }
    // A Session the main process no longer lists (dismissed elsewhere, or
    // reaped) takes its tab with it.
    case 'prune': {
      const live = new Set(action.sessionIds);
      // A tab still waiting on (or refused) its shell has no Session yet.
      const gone = state.tabs.filter(
        (t) => t.kind === 'terminal' && t.sessionId && !live.has(t.sessionId)
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

// A browser tab shows the page title, else its host, else "New Tab".
export function browserTabTitle(tab, state) {
  const title = state?.title?.trim();
  if (title) return title;
  const url = state?.url || tab.url;
  try {
    const { protocol, host } = new URL(url);
    if (protocol === 'http:' || protocol === 'https:') return host;
  } catch {
    // not a URL yet — fall through
  }
  return 'New Tab';
}

// Whether the minimised launcher should show its attention dot.
export function needsAttention(sessions) {
  return sessions.some((s) => !s.exited && (s.unread || s.state === 'needs-input'));
}

// ── Layout persistence ───────────────────────────────────────────────────────
// What survives a restart: tab order, the focused tab and where each terminal
// was opened. Never a sessionId — after a restart every shell is a fresh one
// (ADR 0001: no daemon, nothing outlives the app).

export const LAYOUT_STORAGE_KEY = 'wpxen.floatingWorkspace.tabs';
const RESTORABLE_URL = /^(https?:\/\/|about:blank$)/i;

export function serializeLayout(state) {
  const tabs = state.tabs
    .map((t) => {
      if (t.kind === 'terminal') return { kind: 'terminal', id: t.id, cwd: t.cwd };
      if (t.kind === 'browser') return { kind: 'browser', id: t.id, url: t.url };
      return null;
    })
    .filter(Boolean);
  const activeId = tabs.some((t) => t.id === state.activeId) ? state.activeId : null;
  return JSON.stringify({ tabs, activeId });
}

// The saved layout as tabs still to be launched: each terminal comes back
// with no Session, for the panel to start a fresh shell in its cwd. Anything
// malformed is dropped rather than trusted.
export function parseLayout(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || !Array.isArray(data.tabs)) return null;
  const seen = new Set();
  const tabs = [];
  for (const t of data.tabs) {
    if (!t || typeof t.id !== 'string' || !t.id || seen.has(t.id)) continue;
    if (t.kind === 'terminal') {
      if (typeof t.cwd !== 'string' || !t.cwd.trim()) continue;
      tabs.push({ kind: 'terminal', id: t.id, sessionId: null, cwd: t.cwd });
    } else if (t.kind === 'browser') {
      // Only what the browser would load anyway; anything else reopens blank.
      const url =
        typeof t.url === 'string' && RESTORABLE_URL.test(t.url) ? t.url : 'about:blank';
      tabs.push({ kind: 'browser', id: t.id, url });
    } else {
      continue;
    }
    seen.add(t.id);
  }
  if (tabs.length === 0) return null;
  const activeId = tabs.some((t) => t.id === data.activeId) ? data.activeId : tabs[0].id;
  return { tabs, activeId };
}
