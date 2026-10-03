'use strict';

// The Agents working set ("Projects"): an ordered list of project ids the user
// is working with agents on. Opt-in — a project joins when it's added from the
// sidebar or when a Session is launched in it. Pure list transforms; the store
// read/write lives in ipc.cjs.
//
// A project is either a WordPress Site (its id is the Site's) or any folder
// on disk added from the sidebar. A folder project has no Site behind it, so
// its record — { id, kind: 'folder', name, path } plus the same optional
// `launchTargets` and `icon` a Site carries — lives in its own list under
// FOLDERS_KEY, and only for as long as it's a project.

const path = require('path');

const STORE_KEY = 'agentProjects';
const FOLDERS_KEY = 'agentFolders';

// Folder ids carry a prefix so they can never collide with a Site id, and so
// the renderer can tell the kind from the id alone (src/lib/agentsList.js
// mirrors it — keep the two in sync).
const FOLDER_ID_PREFIX = 'folder-';

const isFolderId = (id) => typeof id === 'string' && id.startsWith(FOLDER_ID_PREFIX);

// One spelling per directory, so the same folder picked twice (with or
// without a trailing slash) is recognised as the same project.
function normalizeDir(dir) {
  const resolved = path.resolve(String(dir || ''));
  return resolved.length > 1 ? resolved.replace(/[/\\]+$/, '') : resolved;
}

// A new folder project for `dir`. `uuid` is passed in to keep this pure.
function folderProject(dir, uuid) {
  const p = normalizeDir(dir);
  return {
    id: `${FOLDER_ID_PREFIX}${uuid}`,
    kind: 'folder',
    name: path.basename(p) || p,
    path: p,
  };
}

// The id of a project already rooted at `dir` — a Site whose folder it is
// (adding a Site's own folder just adds the Site), else a folder project.
function projectIdForPath(dir, sites, folders) {
  const p = normalizeDir(dir);
  const same = (x) => x?.path && normalizeDir(x.path) === p;
  return (sites || []).find(same)?.id || (folders || []).find(same)?.id || null;
}

// Every record a project id can name, each tagged with its kind.
function projectRecords(sites, folders) {
  return [
    ...(sites || []).map((s) => ({ ...s, kind: 'site' })),
    ...(folders || []).map((f) => ({ ...f, kind: 'folder' })),
  ];
}

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

// Drop ids whose project no longer exists. `records` is every Site and folder
// project (see projectRecords).
function pruneProjects(list, records) {
  const ids = new Set((records || []).map((s) => s.id));
  const out = list.filter((id) => ids.has(id));
  return out.length === list.length ? list : out;
}

module.exports = {
  STORE_KEY,
  FOLDERS_KEY,
  FOLDER_ID_PREFIX,
  isFolderId,
  normalizeDir,
  folderProject,
  projectIdForPath,
  projectRecords,
  addProject,
  removeProject,
  reorderProjects,
  pruneProjects,
};
