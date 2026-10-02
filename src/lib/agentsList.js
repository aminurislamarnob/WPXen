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
