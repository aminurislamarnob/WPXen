// Pure row model behind the Agents "Projects" sidebar (AgentsSidebar.jsx): the
// working set of Sites, each with its agent Sessions. Kept out of the component
// so it's testable without a DOM.

// What a Session row (and its terminal tab) is called: the agent's own
// terminal title when it has set one, else the saved Launch Target's label,
// else the provider name — numbered when the same provider runs more than once
// in the Site ("Claude #2").
export function sessionTitle(session, siblings) {
  if (session.title) return session.title;
  if (session.label) return session.label;
  const same = siblings.filter((s) => s.agentId === session.agentId);
  if (same.length < 2) return session.agentName;
  const n = same.findIndex((s) => s.sessionId === session.sessionId) + 1;
  return `${session.agentName} #${n}`;
}

// Working-set ids + all Sites + all Sessions → ordered project rows:
//   [{ site, sessions: [{ ...session, displayTitle }] }]
// Projects keep the working-set order; ids whose Site is gone are skipped.
// Sessions stay in launch order (oldest first).
export function buildProjects({ projectIds, sites, sessions }) {
  const byId = new Map((sites || []).map((s) => [s.id, s]));
  const bySite = new Map();
  const ordered = [...(sessions || [])].sort((a, b) => a.startedAt - b.startedAt);
  for (const s of ordered) {
    if (!bySite.has(s.siteId)) bySite.set(s.siteId, []);
    bySite.get(s.siteId).push(s);
  }

  const out = [];
  for (const id of projectIds || []) {
    const site = byId.get(id);
    if (!site) continue;
    const list = bySite.get(id) || [];
    out.push({
      site,
      sessions: list.map((s) => ({ ...s, displayTitle: sessionTitle(s, list) })),
    });
  }
  return out;
}

// Compact age for a Session row ("now", "4m", "3h", "2d") — time since its
// last status change, so "✓ 12m" reads as "finished twelve minutes ago".
export function formatAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// How urgently a Session state wants the user, most first. A collapsed
// project shows its most urgent Session's glyph, so it still rings or spins.
const URGENCY = ['needs-input', 'working', 'error', 'done', 'exited', 'idle'];

export function mostUrgent(sessions) {
  let best = null;
  for (const s of sessions || []) {
    const rank = URGENCY.indexOf(s.state);
    if (rank !== -1 && (best === null || rank < URGENCY.indexOf(best))) best = s.state;
  }
  return best;
}

// The Activity view: every Session across the working set in one flat list,
// with what needs the user on top — needs-input, then working, then the rest
// by most recent status change. Each row carries its Site's name.
const ACTIVITY_RANK = { 'needs-input': 0, working: 1 };

export function buildActivity(projects) {
  const rows = [];
  for (const { site, sessions } of projects || []) {
    for (const s of sessions) rows.push({ ...s, siteName: site.name });
  }
  const rank = (s) => ACTIVITY_RANK[s.state] ?? 2;
  return rows.sort((a, b) => rank(a) - rank(b) || b.changedAt - a.changedAt);
}

// Sidebar Options (the sliders menu). Per-viewer, stored in localStorage by
// the sidebar; these are the defaults and the transforms they drive.
export const DEFAULT_LIST_OPTIONS = {
  projectSort: 'manual', // manual | recent | name
  sessionSort: 'attention', // attention | launch
  hideExited: false,
  hideEmpty: false,
  display: 'detailed', // detailed | compact
};

// Attention order within a project: what needs the user, then what's busy,
// then what's ready to review, then what has ended.
const SESSION_RANK = {
  'needs-input': 0,
  working: 1,
  done: 2,
  idle: 2,
  exited: 3,
  error: 3,
};
const ENDED_STATES = new Set(['exited', 'error']);

// Apply sort + filter options to buildProjects() output. Input sessions are
// in launch order, so 'launch' leaves them as they are.
export function applyListOptions(projects, options = DEFAULT_LIST_OPTIONS) {
  const o = { ...DEFAULT_LIST_OPTIONS, ...options };
  let out = projects.map(({ site, sessions }) => {
    let list = o.hideExited
      ? sessions.filter((s) => !ENDED_STATES.has(s.state))
      : sessions;
    if (o.sessionSort === 'attention') {
      list = [...list].sort(
        (a, b) =>
          (SESSION_RANK[a.state] ?? 4) - (SESSION_RANK[b.state] ?? 4) ||
          b.changedAt - a.changedAt
      );
    }
    return { site, sessions: list };
  });
  if (o.hideEmpty) out = out.filter((p) => p.sessions.length > 0);
  if (o.projectSort === 'name') {
    out = [...out].sort((a, b) => a.site.name.localeCompare(b.site.name));
  } else if (o.projectSort === 'recent') {
    // Most recent status change among a project's sessions; none sorts last.
    const latest = (p) => Math.max(-Infinity, ...p.sessions.map((s) => s.changedAt));
    out = [...out].sort((a, b) => latest(b) - latest(a));
  }
  return out;
}

// How many filters are on — the count badge on the Options button.
export function activeFilterCount(options) {
  return (options?.hideExited ? 1 : 0) + (options?.hideEmpty ? 1 : 0);
}
