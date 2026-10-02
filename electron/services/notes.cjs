'use strict';

// Floating Workspace notes — markdown files the panel's note tabs edit.
//
// New notes live in one app-owned folder (`userData/notes`), named
// untitled.md, untitled-2.md, …; "Open Note…" can also pick a markdown file
// anywhere, which is then readable and writable by that exact path only. A
// note that was never typed in is deleted when its tab closes, so the folder
// doesn't fill up with empty files.
//
// Saving refuses to overwrite a file that changed on disk since it was loaded
// (compared by mtime), so an edit made outside the app is never clobbered by
// autosave.
//
// Filesystem access and the notes folder go through `deps`, the module's test
// seam (vi.mock can't reach .cjs). Electron is resolved lazily, so a test that
// imports this never loads it (see CLAUDE.md, ELECTRON_SKIP_BINARY_DOWNLOAD).

const fs = require('fs');
const path = require('path');

const NOTES_DIRNAME = 'notes';
const MAX_UNTITLED = 100;
const NOTE_EXTENSIONS = ['.md', '.markdown'];

const deps = {
  fs,
  userData: () => require('electron').app.getPath('userData'),
};

function __setDeps(next) {
  Object.assign(deps, next);
}

// Files picked through "Open Note…" — the only notes allowed outside the
// notes folder. Persisted by the caller (see restorePicked / onPickedChange),
// so a picked note's tab still opens after a restart. Most recent last,
// capped so the grant list can't grow forever.
const MAX_PICKED = 50;
const picked = new Set();
let pickedListener = null;

function restorePicked(list) {
  picked.clear();
  for (const file of Array.isArray(list) ? list : []) {
    if (typeof file === 'string' && path.isAbsolute(file) && isMarkdown(file)) {
      picked.add(path.resolve(file));
    }
  }
}

function onPickedChange(cb) {
  pickedListener = cb;
}

function notesDir() {
  const dir = path.join(deps.userData(), NOTES_DIRNAME);
  deps.fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function untitledName(n) {
  return n === 1 ? 'untitled.md' : `untitled-${n}.md`;
}

// Create the first free untitled note. `wx` makes the create itself the
// existence check, so two quick New Notes can't land on the same name.
function createNote() {
  const dir = notesDir();
  for (let n = 1; n <= MAX_UNTITLED; n++) {
    const file = path.join(dir, untitledName(n));
    try {
      deps.fs.writeFileSync(file, '', { flag: 'wx' });
      return { ok: true, path: file, mtimeMs: deps.fs.statSync(file).mtimeMs };
    } catch (err) {
      if (err.code !== 'EEXIST') return { error: err.message };
    }
  }
  return { error: `Too many untitled notes — rename or delete some in ${dir}` };
}

function isMarkdown(file) {
  return NOTE_EXTENSIONS.includes(path.extname(file).toLowerCase());
}

// A note path the renderer may touch: markdown, and either inside the notes
// folder or picked by the user through the open dialog.
function isAllowed(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  const resolved = path.resolve(file);
  if (!isMarkdown(resolved)) return false;
  if (picked.has(resolved)) return true;
  const dir = path.resolve(notesDir());
  return path.dirname(resolved) === dir;
}

function allow(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  const resolved = path.resolve(file);
  if (!isMarkdown(resolved)) return false;
  picked.delete(resolved);
  picked.add(resolved);
  while (picked.size > MAX_PICKED) picked.delete(picked.values().next().value);
  pickedListener?.([...picked]);
  return true;
}

function readNote(file) {
  if (!isAllowed(file)) return { error: 'Not a note this app can open' };
  try {
    const content = deps.fs.readFileSync(file, 'utf8');
    return { ok: true, content, mtimeMs: deps.fs.statSync(file).mtimeMs };
  } catch (err) {
    return { error: err.code === 'ENOENT' ? 'This note no longer exists' : err.message };
  }
}

// Save `content` if the file is still the version loaded at `expectedMtimeMs`.
// `force` overwrites regardless — the user's explicit choice after a conflict.
function saveNote(file, content, expectedMtimeMs, { force = false } = {}) {
  if (!isAllowed(file)) return { error: 'Not a note this app can save' };
  if (typeof content !== 'string') return { error: 'Nothing to save' };
  try {
    if (!force) {
      let current = null;
      try {
        current = deps.fs.statSync(file).mtimeMs;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      if (current !== null && current !== expectedMtimeMs) {
        return { conflict: true, mtimeMs: current };
      }
    }
    deps.fs.writeFileSync(file, content, 'utf8');
    return { ok: true, mtimeMs: deps.fs.statSync(file).mtimeMs };
  } catch (err) {
    return { error: err.message };
  }
}

// On tab close: remove a note that is still empty and was never edited in
// that tab. A picked file is never deleted — only notes the app created.
function discardIfUntouched(file, { edited = false } = {}) {
  if (edited || !isAllowed(file)) return { deleted: false };
  const resolved = path.resolve(file);
  if (picked.has(resolved)) return { deleted: false };
  try {
    if (deps.fs.readFileSync(resolved, 'utf8') !== '') return { deleted: false };
    deps.fs.unlinkSync(resolved);
    return { deleted: true };
  } catch {
    return { deleted: false };
  }
}

module.exports = {
  NOTES_DIRNAME,
  MAX_UNTITLED,
  notesDir,
  createNote,
  isAllowed,
  allow,
  restorePicked,
  onPickedChange,
  readNote,
  saveNote,
  discardIfUntouched,
  __setDeps,
};
