const listeners = new Set();
const state = new Map();
const returnToChatState = new Map();

export function subscribe(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notify() {
  for (const cb of listeners) {
    cb();
  }
}

export function getViewMode(sessionId) {
  return state.get(sessionId) || 'terminal';
}

export function setViewMode(sessionId, mode) {
  if (state.get(sessionId) !== mode) {
    state.set(sessionId, mode);
    notify();
  }
}

export function setReturnToChat(sessionId, value) {
  returnToChatState.set(sessionId, value);
}

export function getReturnToChat(sessionId) {
  return returnToChatState.get(sessionId) || false;
}

// Ended when the shell is gone or the tracker says the agent exited —
// either can lead, so the exit bar never waits on the slower one.
export function isEndedSession(session) {
  if (!session) return false;
  return session.exited === true || session.state === 'exited';
}

// Resume only once the old Session has ended (two live Sessions must never
// drive one conversation), carries its pinned transcript, and runs an Agent
// whose registry entry declares a resume flag.
export function canResumeSession(session, agent) {
  if (!isEndedSession(session)) return false;
  if (!session.transcriptId) return false;
  return Boolean(agent?.resumeFlag);
}
