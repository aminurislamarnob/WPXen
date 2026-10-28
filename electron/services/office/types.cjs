'use strict';

// ── Office domain types ──────────────────────────────────────
// One-time faithful port of claude-agent-verse packages/core/src/types.ts
// (TS → JSDoc typedefs). The vocabulary follows that project's spec and
// WPXen's Office spec (#178). Dependency-free: no electron, no node APIs.

/**
 * Agent State — the visible state of a session character.
 * @typedef {'working' | 'thinking' | 'idle' | 'error' | 'ended' | 'waiting_on_user'} AgentState
 */

/**
 * Agent Kind — which AI coding agent a Session belongs to. Each kind has its
 * own office room and its own transcript format.
 * @typedef {'claude' | 'antigravity'} AgentKind
 */

/**
 * @typedef {Object} FeedEvent
 * @property {string} id
 * @property {'user' | 'assistant'} role
 * @property {'text' | 'tool_use' | 'tool_result' | 'error'} type
 * @property {string} excerpt
 */

/**
 * @typedef {Object} Subagent
 * @property {string} subagentId
 * @property {string} agentType
 * @property {string} description
 * @property {string} toolUseId
 * @property {AgentState} state
 * @property {string} [currentTool]
 * @property {number} [toolStartedAt] Epoch ms when the current tool started
 */

/**
 * Session — one running Claude Code process.
 * Maps to a character at a desk in the 3D office.
 * @typedef {Object} Session
 * @property {number} pid Claude Code process ID (unique while alive). Agents
 *   without a process registry (Antigravity) get a synthetic negative id from
 *   their adapter instead.
 * @property {AgentKind} agent Which agent this is; decides the room and how
 *   transcript lines are read.
 * @property {string} sessionId Stable session UUID assigned by Claude Code.
 * @property {string} cwd Working directory of the session.
 * @property {string} name Human-readable session name (auto-generated or user-set).
 * @property {AgentState} state Current agent state.
 * @property {string} projectKey Project key — git repo name or folder basename.
 * @property {number} startedAt Epoch ms when the session started.
 * @property {string} [title] Session title derived from transcript ai-title
 * @property {string} [lastPrompt] Last prompt given to the agent
 * @property {string} [gitBranch] Git branch active in the cwd
 * @property {string} [currentTool] Name of the tool currently being used (when
 *   state is 'working')
 * @property {number} [toolStartedAt] Epoch ms when the current tool started
 * @property {FeedEvent[]} feed Short recent-event feed (max FEED_CAP entries)
 * @property {Record<string, Subagent>} subagents Subagents spawned by this session
 * @property {boolean} [hookWaiting] Explicit hook waiting state to override
 *   transcript inference
 * @property {number} [lastActivityAt] Epoch ms of the latest user or assistant
 *   transcript line
 * @property {boolean} [onBreak] Idle for at least the break threshold: the
 *   character leaves its desk
 * @property {'busy' | 'idle'} [registryStatus] Claude Code's own busy/idle flag
 *   from the session registry; overrides transcript inference
 */

/**
 * Office — the top-level domain aggregate.
 * Contains all live sessions indexed by PID.
 * @typedef {Object} Office
 * @property {Record<number, Session>} sessions Live sessions keyed by PID.
 * @property {number} waitingCount Number of sessions in waiting_on_user state.
 * @property {number} waitingThresholdMs Configurable threshold for waiting inference.
 * @property {number} breakThresholdMs How long a session stays idle before it
 *   goes on break.
 */

// ── Domain events ─────────────────────────────────────────────

/**
 * @typedef {Object} SessionAppeared
 * @property {'session_appeared'} type
 * @property {number} pid
 * @property {string} sessionId
 * @property {string} cwd
 * @property {string} name
 * @property {string} projectKey
 * @property {number} startedAt
 * @property {AgentKind} [agent] Defaults to "claude", the only kind with a
 *   session registry.
 */

/**
 * An adapter learned where a session works after it appeared (Antigravity has
 * no cwd in its registry, so it is found from the paths its tools touch).
 * @typedef {Object} SessionWorkspace
 * @property {'session_workspace'} type
 * @property {number} pid
 * @property {string} cwd
 * @property {string} projectKey
 */

/**
 * The registry entry's activity status changed. Claude Code keeps this current
 * itself, so it is more reliable than inferring busy/idle from the transcript.
 * @typedef {Object} SessionStatus
 * @property {'session_status'} type
 * @property {number} pid
 * @property {string} status "busy", "idle", or a value this version does not
 *   know (ignored).
 * @property {number} [at] Epoch ms of the status change.
 * @property {string} sessionId The process's current session id; changes when
 *   a new conversation starts in it.
 */

/**
 * @typedef {Object} SessionEnded
 * @property {'session_ended'} type
 * @property {number} pid
 */

/**
 * @typedef {Object} TranscriptLine
 * @property {'transcript_line'} type
 * @property {number} pid
 * @property {*} line
 */

/**
 * @typedef {Object} SubagentAppeared
 * @property {'subagent_appeared'} type
 * @property {number} pid
 * @property {string} subagentId
 * @property {string} agentType
 * @property {string} description
 * @property {string} toolUseId
 */

/**
 * @typedef {Object} SubagentEnded
 * @property {'subagent_ended'} type
 * @property {number} pid
 * @property {string} subagentId
 */

/**
 * @typedef {Object} SubagentTranscriptLine
 * @property {'subagent_transcript_line'} type
 * @property {number} pid
 * @property {string} subagentId
 * @property {*} line
 */

/**
 * @typedef {Object} Tick
 * @property {'tick'} type
 * @property {number} now
 */

/**
 * @typedef {Object} HookEvent
 * @property {'hook_event'} type
 * @property {number} pid
 * @property {{ type: string } & Record<string, *>} hookData
 */

/**
 * @typedef {SessionAppeared | SessionWorkspace | SessionEnded | SessionStatus
 *   | TranscriptLine | SubagentAppeared | SubagentEnded
 *   | SubagentTranscriptLine | Tick | HookEvent} DomainEvent
 */

// ── Constants ─────────────────────────────────────────────────
// Product constants, identical to the source project — deliberately not
// settings (see spec #178: "no invented knobs").

/** A running tool past this long means the agent is waiting on the user. */
const WAITING_THRESHOLD_MS = 15000;

/** Idle at least this long sends the character to the lounge. */
const BREAK_THRESHOLD_MS = 5 * 60_000;

/** A session's recent-event feed keeps at most this many entries. */
const FEED_CAP = 20;

module.exports = {
  WAITING_THRESHOLD_MS,
  BREAK_THRESHOLD_MS,
  FEED_CAP,
};
