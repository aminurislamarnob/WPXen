'use strict';

// ── Office reducer ───────────────────────────────────────────
// One-time faithful port of claude-agent-verse packages/core/src/reducer.ts.
// Pure and immutable: reduce(office, event) returns a NEW Office when the
// event changed something, and the SAME object reference when it changed
// nothing — the engine relies on that to skip snapshot broadcasts.
// Dependency-free: no electron, no node APIs.

const {
  WAITING_THRESHOLD_MS,
  BREAK_THRESHOLD_MS,
  FEED_CAP,
  ENDED_LINGER_MS,
} = require('./types.cjs');

/** @typedef {import('./types.cjs').Office} Office */
/** @typedef {import('./types.cjs').Session} Session */
/** @typedef {import('./types.cjs').Subagent} Subagent */
/** @typedef {import('./types.cjs').FeedEvent} FeedEvent */
/** @typedef {import('./types.cjs').DomainEvent} DomainEvent */

/**
 * @param {string} str
 * @param {number} len
 * @returns {string}
 */
function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '...' : str;
}

/**
 * @param {Session} session
 * @param {*} line
 * @returns {Session}
 */
function processTranscriptLine(session, line) {
  const next = { ...session };

  if (line.gitBranch) {
    next.gitBranch = line.gitBranch;
  }

  if (line.type === 'ai-title' && line.aiTitle) {
    next.title = line.aiTitle;
    return next;
  }

  if (line.type === 'last-prompt' && line.lastPrompt) {
    next.lastPrompt = line.lastPrompt;
    return next;
  }

  const content = line.message?.content;
  /** @type {FeedEvent | null} */
  let newFeedEvent = null;
  const uuid = line.uuid || Date.now().toString();
  const timestamp = line.timestamp ? new Date(line.timestamp).getTime() : Date.now();

  if (line.type === 'assistant' || line.type === 'user') {
    next.lastActivityAt = timestamp;
    next.onBreak = false;
  }

  if (line.type === 'assistant') {
    if (Array.isArray(content)) {
      const toolUse = content.find((c) => c.type === 'tool_use');
      if (toolUse) {
        if (!next.hookWaiting) {
          next.state = 'working';
        }
        next.currentTool = toolUse.name;
        next.toolStartedAt = timestamp;
        newFeedEvent = {
          id: uuid,
          role: 'assistant',
          type: 'tool_use',
          excerpt: `Used tool: ${toolUse.name}`,
        };
      } else {
        if (!next.hookWaiting) {
          next.state = 'idle';
        }
        next.currentTool = undefined;
        next.toolStartedAt = undefined;
        const textBlock = content.find((c) => c.type === 'text');
        if (textBlock && textBlock.text) {
          newFeedEvent = {
            id: uuid,
            role: 'assistant',
            type: 'text',
            excerpt: truncate(textBlock.text, 100),
          };
        }
      }
    }
  } else if (line.type === 'user') {
    next.hookWaiting = false; // User activity clears the hook waiting state
    if (Array.isArray(content)) {
      const toolResult = content.find((c) => c.type === 'tool_result');
      if (toolResult) {
        if (toolResult.is_error) {
          next.state = 'error';
          next.currentTool = undefined;
          next.toolStartedAt = undefined;
          newFeedEvent = {
            id: uuid,
            role: 'user',
            type: 'error',
            excerpt: 'Tool error occurred.',
          };
        } else {
          next.state = 'thinking';
          next.currentTool = undefined;
          next.toolStartedAt = undefined;
          newFeedEvent = {
            id: uuid,
            role: 'user',
            type: 'tool_result',
            excerpt: `Tool finished: ${line.toolUseResult?.commandName || 'success'}`,
          };
        }
      } else {
        next.state = 'thinking';
        next.currentTool = undefined;
        next.toolStartedAt = undefined;
        const textBlock = content.find((c) => c.type === 'text');
        if (textBlock && textBlock.text) {
          newFeedEvent = {
            id: uuid,
            role: 'user',
            type: 'text',
            excerpt: truncate(textBlock.text, 100),
          };
        }
      }
    } else if (typeof content === 'string') {
      next.state = 'thinking';
      next.currentTool = undefined;
      next.toolStartedAt = undefined;
      newFeedEvent = {
        id: uuid,
        role: 'user',
        type: 'text',
        excerpt: truncate(content, 100),
      };
    }
  }

  if (newFeedEvent) {
    next.feed = [...next.feed, newFeedEvent].slice(-FEED_CAP);
  }

  return next;
}

/**
 * @param {Subagent} subagent
 * @param {*} line
 * @returns {Subagent}
 */
function processSubagentTranscriptLine(subagent, line) {
  const next = { ...subagent };
  const content = line.message?.content;
  const timestamp = line.timestamp ? new Date(line.timestamp).getTime() : Date.now();

  if (line.type === 'assistant') {
    if (Array.isArray(content)) {
      const toolUse = content.find((c) => c.type === 'tool_use');
      if (toolUse) {
        next.state = 'working';
        next.currentTool = toolUse.name;
        next.toolStartedAt = timestamp;
      } else {
        next.state = 'idle';
        next.currentTool = undefined;
        next.toolStartedAt = undefined;
      }
    }
  } else if (line.type === 'user') {
    if (Array.isArray(content)) {
      const toolResult = content.find((c) => c.type === 'tool_result');
      if (toolResult) {
        if (toolResult.is_error) {
          next.state = 'error';
          next.currentTool = undefined;
          next.toolStartedAt = undefined;
        } else {
          next.state = 'thinking';
          next.currentTool = undefined;
          next.toolStartedAt = undefined;
        }
      } else {
        next.state = 'thinking';
        next.currentTool = undefined;
        next.toolStartedAt = undefined;
      }
    } else if (typeof content === 'string') {
      next.state = 'thinking';
      next.currentTool = undefined;
      next.toolStartedAt = undefined;
    }
  }
  return next;
}

// ── Antigravity ──────────────────────────────────────────────
// Antigravity writes one JSON step per line to brain/<id>/.system_generated/logs/transcript.jsonl.
// The format is not a public API: unknown step types and odd field shapes leave the session as it was.

/**
 * Plain text of a step's content, which may be a string or a list of parts.
 * @param {*} content
 * @returns {string}
 */
function stepText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (typeof c === 'string' ? c : typeof c?.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * The user's own words, when the prompt wraps them in a <USER_REQUEST> block.
 * @param {string} text
 * @returns {string}
 */
function userRequest(text) {
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(text);
  return (m ? m[1] : text).trim();
}

/**
 * @param {Session} session
 * @param {*} step
 * @returns {Session}
 */
function processAntigravityStep(session, step) {
  if (!step || typeof step !== 'object') return session;
  const parsed = Date.parse(step.created_at);
  const timestamp = Number.isNaN(parsed) ? Date.now() : parsed;
  // A step may be written again as it finishes; its feed entry is then replaced.
  const id =
    typeof step.step_index === 'number' ? `step-${step.step_index}` : String(timestamp);
  const next = { ...session };
  /** @type {Omit<FeedEvent, 'id'> | null} */
  let event = null;
  const clearTool = () => {
    next.currentTool = undefined;
    next.toolStartedAt = undefined;
  };

  switch (step.type) {
    case 'USER_INPUT': {
      const prompt = userRequest(stepText(step.content));
      next.state = 'thinking';
      clearTool();
      if (prompt) {
        next.lastPrompt = prompt;
        next.title ??= truncate(prompt, 60);
        event = { role: 'user', type: 'text', excerpt: truncate(prompt, 100) };
      }
      break;
    }
    case 'PLANNER_RESPONSE': {
      if (step.tool_calls !== undefined && !Array.isArray(step.tool_calls))
        return session;
      const tool = (step.tool_calls ?? [])
        .map((c) => c?.name)
        .find((n) => typeof n === 'string' && n);
      if (tool) {
        next.state = 'working';
        next.currentTool = tool;
        next.toolStartedAt = timestamp;
        event = { role: 'assistant', type: 'tool_use', excerpt: `Used tool: ${tool}` };
      } else {
        // No tool call: the model is still answering, or its answer ends the turn.
        next.state = step.status === 'RUNNING' ? 'thinking' : 'idle';
        clearTool();
        const text = stepText(step.content);
        if (text)
          event = { role: 'assistant', type: 'text', excerpt: truncate(text, 100) };
      }
      break;
    }
    case 'GENERIC': {
      // Tool output; other generic steps outside a tool call say nothing about state.
      if (!session.currentTool) return session;
      event = {
        role: 'user',
        type: 'tool_result',
        excerpt: `Tool finished: ${session.currentTool}`,
      };
      next.state = 'thinking';
      clearTool();
      break;
    }
    case 'ERROR_MESSAGE': {
      next.state = 'error';
      clearTool();
      event = {
        role: 'user',
        type: 'error',
        excerpt: truncate(stepText(step.content) || 'Agent error.', 100),
      };
      break;
    }
    default:
      return session;
  }

  next.lastActivityAt = timestamp;
  next.onBreak = false;
  if (event)
    next.feed = [...next.feed.filter((e) => e.id !== id), { id, ...event }].slice(
      -FEED_CAP
    );
  return next;
}

/**
 * Derived state: waiting-on-you inference past the threshold, break logic, and
 * the registry busy/idle override. Returns the same Office when nothing changed.
 * @param {Office} office
 * @param {number} [now]
 * @returns {Office}
 */
function computeOfficeState(office, now) {
  let waitingCount = 0;
  let changed = false;
  const nextSessions = { ...office.sessions };

  for (const pid of Object.keys(nextSessions)) {
    const session = nextSessions[Number(pid)];

    // An ended session takes no part in the derivations below. The first tick
    // stamps when it ended; the first tick past the linger removes it.
    if (session.state === 'ended') {
      if (now === undefined) continue;
      if (session.endedAt === undefined) {
        nextSessions[Number(pid)] = { ...session, endedAt: now };
        changed = true;
      } else if (now - session.endedAt >= ENDED_LINGER_MS) {
        delete nextSessions[Number(pid)];
        changed = true;
      }
      continue;
    }

    let sessionChanged = false;
    let nextSession = { ...session };

    // The registry knows whether the session is busy; the transcript only refines how.
    if (
      nextSession.registryStatus === 'idle' &&
      !nextSession.hookWaiting &&
      nextSession.state !== 'idle'
    ) {
      nextSession.state = 'idle';
      nextSession.currentTool = undefined;
      nextSession.toolStartedAt = undefined;
      sessionChanged = true;
    } else if (nextSession.registryStatus === 'busy' && nextSession.state === 'idle') {
      nextSession.state = 'thinking';
      sessionChanged = true;
    }

    // Check parent session
    if (
      now !== undefined &&
      nextSession.state === 'working' &&
      nextSession.toolStartedAt
    ) {
      if (now - nextSession.toolStartedAt >= office.waitingThresholdMs) {
        nextSession.state = 'waiting_on_user';
        sessionChanged = true;
      }
    }

    if (nextSession.state === 'waiting_on_user') {
      waitingCount++;
    }

    // A break starts on a tick after enough idle time and ends the moment the session is busy again.
    const idleFor =
      now === undefined ? 0 : now - (nextSession.lastActivityAt ?? nextSession.startedAt);
    const onBreak =
      nextSession.state === 'idle' &&
      (now === undefined ? !!nextSession.onBreak : idleFor >= office.breakThresholdMs);
    if (onBreak !== !!nextSession.onBreak) {
      nextSession.onBreak = onBreak;
      sessionChanged = true;
    }

    // Check subagents
    let subagentsChanged = false;
    const nextSubagents = { ...nextSession.subagents };
    for (const subId of Object.keys(nextSubagents)) {
      const sub = nextSubagents[subId];
      if (now !== undefined && sub.state === 'working' && sub.toolStartedAt) {
        if (now - sub.toolStartedAt >= office.waitingThresholdMs) {
          nextSubagents[subId] = { ...sub, state: 'waiting_on_user' };
          subagentsChanged = true;
        }
      }
      if (nextSubagents[subId].state === 'waiting_on_user') {
        waitingCount++;
      }
    }

    if (subagentsChanged) {
      nextSession.subagents = nextSubagents;
      sessionChanged = true;
    }

    if (sessionChanged) {
      nextSessions[Number(pid)] = nextSession;
      changed = true;
    }
  }

  // Update count if it changed, or if sessions changed
  if (changed || waitingCount !== office.waitingCount) {
    return { ...office, sessions: nextSessions, waitingCount };
  }

  return office;
}

/**
 * @param {Office} office
 * @param {DomainEvent} event
 * @returns {Office}
 */
function reduce(office, event) {
  let next = office;

  // An ended session is only lingering: nothing but its replacement at the
  // same pid (session_appeared) or the tick that removes it touches it.
  if (
    event.type !== 'session_appeared' &&
    event.type !== 'tick' &&
    office.sessions[event.pid]?.state === 'ended'
  ) {
    return office;
  }

  switch (event.type) {
    case 'session_appeared': {
      // A new process can reuse the pid of one still lingering as ended.
      if (!office.sessions[event.pid] || office.sessions[event.pid].state === 'ended') {
        next = {
          ...office,
          sessions: {
            ...office.sessions,
            [event.pid]: {
              pid: event.pid,
              agent: event.agent ?? 'claude',
              sessionId: event.sessionId,
              cwd: event.cwd,
              name: event.name,
              state: 'idle',
              projectKey: event.projectKey,
              startedAt: event.startedAt,
              feed: [],
              subagents: {},
            },
          },
        };
      }
      break;
    }

    case 'session_workspace': {
      const session = office.sessions[event.pid];
      if (session) {
        next = {
          ...office,
          sessions: {
            ...office.sessions,
            [event.pid]: { ...session, cwd: event.cwd, projectKey: event.projectKey },
          },
        };
      }
      break;
    }

    case 'session_ended': {
      // Visibly ended before it leaves: the session stays, as `ended`, until a
      // tick past ENDED_LINGER_MS removes it. Its interns leave with it now.
      const session = office.sessions[event.pid];
      if (!session) break;
      next = {
        ...office,
        sessions: {
          ...office.sessions,
          [event.pid]: {
            ...session,
            state: 'ended',
            currentTool: undefined,
            toolStartedAt: undefined,
            hookWaiting: false,
            onBreak: false,
            subagents: {},
            endedAt: undefined,
          },
        },
      };
      break;
    }

    case 'session_status': {
      const session = office.sessions[event.pid];
      if (!session) break;
      /** @type {Session} */
      let nextSession = { ...session };
      if (event.sessionId && event.sessionId !== session.sessionId) {
        // A new conversation in the same process: drop what belonged to the old one.
        nextSession = {
          ...nextSession,
          sessionId: event.sessionId,
          title: undefined,
          lastPrompt: undefined,
          currentTool: undefined,
          toolStartedAt: undefined,
          feed: [],
          subagents: {},
        };
      }
      const known =
        event.status === 'busy' || event.status === 'idle' ? event.status : undefined;
      nextSession.registryStatus = known;
      if (known === 'idle' && event.at !== undefined) {
        nextSession.lastActivityAt = Math.max(nextSession.lastActivityAt ?? 0, event.at);
      }
      if (known === 'busy') nextSession.onBreak = false;
      next = { ...office, sessions: { ...office.sessions, [event.pid]: nextSession } };
      break;
    }

    case 'transcript_line': {
      const session = office.sessions[event.pid];
      if (session) {
        next = {
          ...office,
          sessions: {
            ...office.sessions,
            [event.pid]:
              session.agent === 'antigravity'
                ? processAntigravityStep(session, event.line)
                : processTranscriptLine(session, event.line),
          },
        };
      }
      break;
    }

    case 'subagent_appeared': {
      const session = office.sessions[event.pid];
      if (session) {
        /** @type {Subagent} */
        const newSubagent = {
          subagentId: event.subagentId,
          agentType: event.agentType,
          description: event.description,
          toolUseId: event.toolUseId,
          state: 'idle',
        };
        next = {
          ...office,
          sessions: {
            ...office.sessions,
            [event.pid]: {
              ...session,
              subagents: {
                ...session.subagents,
                [event.subagentId]: newSubagent,
              },
            },
          },
        };
      }
      break;
    }

    case 'subagent_ended': {
      const session = office.sessions[event.pid];
      if (session) {
        const restSubagents = { ...session.subagents };
        delete restSubagents[event.subagentId];
        next = {
          ...office,
          sessions: {
            ...office.sessions,
            [event.pid]: {
              ...session,
              subagents: restSubagents,
            },
          },
        };
      }
      break;
    }

    case 'subagent_transcript_line': {
      const session = office.sessions[event.pid];
      if (session) {
        const subagent = session.subagents[event.subagentId];
        if (subagent) {
          next = {
            ...office,
            sessions: {
              ...office.sessions,
              [event.pid]: {
                ...session,
                subagents: {
                  ...session.subagents,
                  [event.subagentId]: processSubagentTranscriptLine(subagent, event.line),
                },
              },
            },
          };
        }
      }
      break;
    }

    case 'hook_event': {
      // Find session by PID or fallback to matching sessionId from hookData
      let session = office.sessions[event.pid];
      let matchingPid = event.pid;

      if (!session && event.hookData?.sessionId) {
        for (const pidStr of Object.keys(office.sessions)) {
          const s = office.sessions[Number(pidStr)];
          if (s && s.state !== 'ended' && s.sessionId === event.hookData.sessionId) {
            session = s;
            matchingPid = Number(pidStr);
            break;
          }
        }
      }

      if (session) {
        const hType = event.hookData.type;
        let hookWaiting = !!session.hookWaiting;
        let state = session.state;

        if (hType === 'PermissionRequest' || hType === 'Notification') {
          hookWaiting = true;
          state = 'waiting_on_user';
        } else if (
          hType === 'PreToolUse' ||
          hType === 'PostToolUse' ||
          hType === 'PostToolUseFailure'
        ) {
          hookWaiting = false;
          if (hType === 'PreToolUse') {
            state = 'working';
          }
        }

        // Most hooks (SessionStart/End, Stop, Subagent*, a repeat) change
        // nothing; keep the reference so the engine pushes no snapshot.
        if (hookWaiting === !!session.hookWaiting && state === session.state) break;

        const nextSession = { ...session, hookWaiting, state };
        next = {
          ...office,
          sessions: {
            ...office.sessions,
            [matchingPid]: nextSession,
          },
        };
      }
      break;
    }

    case 'tick': {
      return computeOfficeState(next, event.now);
    }
  }

  // Also try to compute office state after any transcript updates that might clear a waiting state.
  return computeOfficeState(next);
}

/**
 * @returns {Office}
 */
function emptyOffice() {
  return {
    sessions: {},
    waitingCount: 0,
    waitingThresholdMs: WAITING_THRESHOLD_MS,
    breakThresholdMs: BREAK_THRESHOLD_MS,
  };
}

module.exports = { reduce, emptyOffice, computeOfficeState };
