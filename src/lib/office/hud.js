import { stateLabel } from './scene/theme.js';

// ── Office HUD derivations ───────────────────────────────────
// What the agent list and the inspector show, derived from an Office snapshot
// as plain values so the ordering and the badges are unit-testable without a
// DOM. The components in src/components/office/ only render these.

/**
 * Triage order: the agent blocking on you first, then failures, then busy,
 * then quiet. Ported from the source AgentList's PRIORITY.
 */
export const STATE_PRIORITY = {
  waiting_on_user: 0,
  error: 1,
  working: 2,
  thinking: 3,
  idle: 4,
  ended: 5,
};

/** States this version doesn't know sort after every known one. */
const UNKNOWN_PRIORITY = 9;

const priority = (state) => STATE_PRIORITY[state] ?? UNKNOWN_PRIORITY;

/**
 * The inspector shows at most this many feed entries, newest last. The engine
 * already keeps each session's feed to the same length (FEED_CAP in
 * electron/services/office/types.cjs); this keeps the panel bounded whatever
 * a snapshot carries.
 */
export const INSPECTOR_FEED_CAP = 20;

export const FEED_LABEL = {
  text: 'Message',
  tool_use: 'Tool call',
  tool_result: 'Result',
  error: 'Error',
};

/**
 * Agent State → badge tone. Tones name WPXen's semantic tokens, never a
 * colour: waiting/error/idle land on the status tokens (which match the
 * scene's own waiting/error/idle colours), working and thinking share the
 * brand `highlight`, and ended is muted.
 */
const STATE_TONE = {
  waiting_on_user: 'warning',
  error: 'error',
  idle: 'running',
  working: 'highlight',
  thinking: 'highlight',
  ended: 'muted',
};

/**
 * @param {string} state Agent State
 * @param {{ tool?: string, onBreak?: boolean }} [opts]
 * @returns {{ label: string, tone: string, tool: string | undefined }}
 */
export function stateBadge(state, { tool, onBreak = false } = {}) {
  return {
    label: onBreak && state === 'idle' ? 'On break' : (stateLabel[state] ?? state),
    tone: STATE_TONE[state] ?? 'muted',
    tool: state === 'working' && tool ? tool : undefined,
  };
}

/** Interns most urgent first; a stable sort keeps arrival order among equals. */
function sortedInterns(session) {
  return Object.values(session.subagents ?? {}).sort(
    (a, b) => priority(a.state) - priority(b.state)
  );
}

/**
 * A session's place in the triage order. An intern waiting on you makes its
 * parent row waiting too: the room tabs already count that intern as waiting
 * (rooms.js waitingIn), and the row is where you'd find it.
 */
function urgency(session) {
  const internWaiting = Object.values(session.subagents ?? {}).some(
    (sub) => sub.state === 'waiting_on_user'
  );
  return internWaiting ? STATE_PRIORITY.waiting_on_user : priority(session.state);
}

/**
 * The agent list: sessions grouped by project, most urgent project first
 * (ties by name), and within a project most urgent first (ties by start
 * time). Recomputed from every snapshot, so the order follows the office live.
 *
 * @param {{ sessions: Record<number, object> }} office
 * @returns {{ projectKey: string, sessions: { session: object, interns: object[] }[] }[]}
 */
export function agentList(office) {
  const byProject = new Map();
  for (const session of Object.values(office.sessions)) {
    const rows = byProject.get(session.projectKey) ?? [];
    rows.push({ session, interns: sortedInterns(session), rank: urgency(session) });
    byProject.set(session.projectKey, rows);
  }
  return [...byProject.entries()]
    .map(([projectKey, rows]) => ({
      projectKey,
      rank: Math.min(...rows.map((r) => r.rank)),
      rows: rows.sort(
        (a, b) => a.rank - b.rank || a.session.startedAt - b.session.startedAt
      ),
    }))
    .sort((a, b) => a.rank - b.rank || a.projectKey.localeCompare(b.projectKey))
    .map(({ projectKey, rows }) => ({
      projectKey,
      sessions: rows.map(({ session, interns }) => ({ session, interns })),
    }));
}

function internView(sub) {
  return {
    subagentId: sub.subagentId,
    agentType: sub.agentType,
    description: sub.description,
    badge: stateBadge(sub.state, { tool: sub.currentTool }),
  };
}

/**
 * Everything the inspector shows for one session, and for the focused intern
 * when there is one.
 *
 * @param {object} session
 * @param {string} [subagentId] The focused intern, if any.
 */
export function inspectorView(session, subagentId) {
  const focused = subagentId ? session.subagents?.[subagentId] : undefined;
  return {
    pid: session.pid,
    title: session.title || session.name,
    // The registry name is worth showing only when the title isn't it.
    name: session.title && session.title !== session.name ? session.name : undefined,
    projectKey: session.projectKey,
    gitBranch: session.gitBranch,
    lastPrompt: session.lastPrompt,
    badge: stateBadge(session.state, {
      tool: session.currentTool,
      onBreak: session.onBreak,
    }),
    intern: focused ? internView(focused) : null,
    interns: sortedInterns(session).map(internView),
    feed: (session.feed ?? []).slice(-INSPECTOR_FEED_CAP).map((event) => ({
      id: event.id,
      role: event.role,
      type: event.type,
      label: FEED_LABEL[event.type] ?? event.type,
      excerpt: event.excerpt,
    })),
  };
}
