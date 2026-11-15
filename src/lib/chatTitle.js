// The name a chat's header shows, ranked the way Orca ranks a Claude
// session's title (stablyai/orca, session-scanner-primary-parsers.ts):
//
//   1. custom — the user's own /rename (`custom-title` record)
//   2. ai     — the name Claude generates (`ai-title`)
//   3. the first real prompt the user typed
//   4. agent  — metadata (`agent-name`)
//   5. the Session's terminal title, then the Agent's name
//
// A new conversation has no ai-title until Claude names it after the first
// turn, so the prompt is what fills the header in the meantime. Only the
// loaded pages are searched: with older pages unloaded, the earliest loaded
// prompt stands in for the first one.

const clean = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

// Merge a push's header ({ custom?, ai?, agent? }) into the titles so far.
export function mergeChatTitles(prev, header) {
  if (!header || typeof header !== 'object') return prev;
  let next = prev;
  for (const kind of ['custom', 'ai', 'agent']) {
    const title = clean(header[kind]);
    if (title && title !== prev[kind]) next = { ...next, [kind]: title };
  }
  return next;
}

export function resolveChatTitle({ titles = {}, messages = [], session = null } = {}) {
  const ranked = [titles.custom, titles.ai];
  const firstPrompt = messages.find((m) => m?.role === 'user' && clean(m.content));
  ranked.push(firstPrompt?.content, titles.agent, session?.title, session?.agentName);
  for (const candidate of ranked) {
    const title = clean(candidate);
    if (title) return title;
  }
  return '';
}
