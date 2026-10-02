'use strict';

// The Agents working set ("Projects"): an ordered list of site ids the user is
// working with agents on. Opt-in — a site joins when it's added from the
// sidebar or when a Session is launched in it. Pure list transforms; the store
// read/write lives in ipc.cjs.

const STORE_KEY = 'agentProjects';

// Append `siteId` unless it's already a member. Returns the same array when
// nothing changed, so callers can skip a store write.
function addProject(list, siteId) {
  if (!siteId || list.includes(siteId)) return list;
  return [...list, siteId];
}

function removeProject(list, siteId) {
  return list.includes(siteId) ? list.filter((id) => id !== siteId) : list;
}

// Apply a user reorder. Only ids already in the list are honoured, and any
// member the new order leaves out keeps its relative place at the end — so a
// stale renderer can never drop or invent a project.
function reorderProjects(list, order) {
  const known = new Set(list);
  const seen = new Set();
  const out = [];
  for (const id of order || []) {
    if (known.has(id) && !seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  for (const id of list) if (!seen.has(id)) out.push(id);
  return out;
}

// Drop ids whose site no longer exists.
function pruneProjects(list, sites) {
  const ids = new Set((sites || []).map((s) => s.id));
  const out = list.filter((id) => ids.has(id));
  return out.length === list.length ? list : out;
}

module.exports = { STORE_KEY, addProject, removeProject, reorderProjects, pruneProjects };
