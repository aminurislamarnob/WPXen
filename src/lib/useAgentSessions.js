import { useEffect, useState, useSyncExternalStore } from 'react';

// Live agent Sessions (every Site, live and exited) and the Agents working set,
// as pushed by the main process. Both the Projects sidebar and the Agents pane
// read these, so a launch, exit or dismiss in one shows up in the other.

export function useAgentSessions() {
  const [sessions, setSessions] = useState([]);
  useEffect(() => {
    const api = window.electronAPI;
    let cancelled = false;
    api.listAllSessions().then((list) => {
      if (!cancelled) setSessions(list || []);
    });
    const off = api.on('agent-sessions-update', (list) => setSessions(list || []));
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  return sessions;
}

export function useAgentProjects() {
  const [ids, setIds] = useState([]);
  useEffect(() => {
    const api = window.electronAPI;
    let cancelled = false;
    api.getAgentProjects().then((list) => {
      if (!cancelled) setIds(list || []);
    });
    const off = api.on('agent-projects-update', (list) => setIds(list || []));
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  return ids;
}

// The Session on screen in the Agents pane. The pane writes it; the sidebar
// reads it to highlight the row. A tiny external store rather than context,
// since the two components sit in different branches of Layout.
let selected = null;
const listeners = new Set();

export function setSelectedSession(sessionId) {
  if (selected === sessionId) return;
  selected = sessionId;
  for (const l of listeners) l();
}

export function useSelectedSession() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => selected
  );
}
