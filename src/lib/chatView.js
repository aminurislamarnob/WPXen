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
