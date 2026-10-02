import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import notes from '../electron/services/notes.cjs';

// The notes folder is pointed at a temp dir through the module's own seam, so
// these run against a real filesystem without touching the app's data.

let userData;
let dir;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-notes-'));
  dir = path.join(userData, 'notes');
  notes.__setDeps({ userData: () => userData, fs });
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe('createNote', () => {
  it('creates the notes folder on first use, then untitled.md', () => {
    expect(fs.existsSync(dir)).toBe(false);
    const res = notes.createNote();
    expect(res).toMatchObject({ ok: true, path: path.join(dir, 'untitled.md') });
    expect(fs.readFileSync(res.path, 'utf8')).toBe('');
  });

  it('numbers later notes, skipping names already taken', () => {
    notes.createNote();
    fs.writeFileSync(path.join(dir, 'untitled-2.md'), 'mine');
    expect(path.basename(notes.createNote().path)).toBe('untitled-3.md');
    expect(fs.readFileSync(path.join(dir, 'untitled-2.md'), 'utf8')).toBe('mine');
  });

  it('gives up after the cap rather than looping forever', () => {
    fs.mkdirSync(dir, { recursive: true });
    for (let n = 1; n <= notes.MAX_UNTITLED; n++) {
      fs.writeFileSync(path.join(dir, n === 1 ? 'untitled.md' : `untitled-${n}.md`), '');
    }
    expect(notes.createNote().error).toMatch(/Too many untitled notes/);
  });
});

describe('which files a note tab may touch', () => {
  it('allows markdown in the notes folder', () => {
    const { path: file } = notes.createNote();
    expect(notes.isAllowed(file)).toBe(true);
  });

  it('refuses anything outside it, non-markdown, or relative', () => {
    notes.notesDir();
    expect(notes.isAllowed(path.join(userData, 'elsewhere.md'))).toBe(false);
    expect(notes.isAllowed(path.join(dir, 'sub', 'deep.md'))).toBe(false);
    expect(notes.isAllowed(path.join(dir, '..', 'escape.md'))).toBe(false);
    expect(notes.isAllowed(path.join(dir, 'script.sh'))).toBe(false);
    expect(notes.isAllowed('untitled.md')).toBe(false);
  });

  it('allows a markdown file picked through Open Note, by that exact path', () => {
    const file = path.join(userData, 'picked.md');
    fs.writeFileSync(file, '# hi');
    expect(notes.isAllowed(file)).toBe(false);
    expect(notes.allow(file)).toBe(true);
    expect(notes.readNote(file)).toMatchObject({ ok: true, content: '# hi' });
    expect(notes.isAllowed(path.join(userData, 'sibling.md'))).toBe(false);
  });

  it('will not allow a picked non-markdown file', () => {
    expect(notes.allow(path.join(userData, 'secrets.txt'))).toBe(false);
  });
});

describe('saveNote', () => {
  it('saves when the file is the version that was loaded', () => {
    const { path: file, mtimeMs } = notes.createNote();
    const res = notes.saveNote(file, '# Plan', mtimeMs);
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('# Plan');
  });

  it('refuses to overwrite a file changed on disk since it was loaded', () => {
    const { path: file, mtimeMs } = notes.createNote();
    fs.writeFileSync(file, 'edited elsewhere');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const res = notes.saveNote(file, 'mine', mtimeMs);
    expect(res.conflict).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('edited elsewhere');
  });

  it('overwrites a conflict when forced', () => {
    const { path: file, mtimeMs } = notes.createNote();
    fs.writeFileSync(file, 'edited elsewhere');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(notes.saveNote(file, 'mine', mtimeMs, { force: true }).ok).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('mine');
  });

  it('returns the new mtime, so the next save does not conflict with itself', () => {
    const { path: file, mtimeMs } = notes.createNote();
    const first = notes.saveNote(file, 'one', mtimeMs);
    expect(notes.saveNote(file, 'two', first.mtimeMs).ok).toBe(true);
  });

  it('refuses a path outside the notes folder', () => {
    const file = path.join(userData, 'other.md');
    expect(notes.saveNote(file, 'x', 0).error).toBeTruthy();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('discardIfUntouched', () => {
  it('deletes a note that is empty and was never edited', () => {
    const { path: file } = notes.createNote();
    expect(notes.discardIfUntouched(file)).toEqual({ deleted: true });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('keeps a note that was edited, even if now empty', () => {
    const { path: file } = notes.createNote();
    expect(notes.discardIfUntouched(file, { edited: true })).toEqual({ deleted: false });
    expect(fs.existsSync(file)).toBe(true);
  });

  it('keeps a note with content', () => {
    const { path: file, mtimeMs } = notes.createNote();
    notes.saveNote(file, 'keep me', mtimeMs);
    expect(notes.discardIfUntouched(file)).toEqual({ deleted: false });
  });

  it('never deletes a file the user picked', () => {
    const file = path.join(dir, 'chosen.md');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, '');
    notes.allow(file);
    expect(notes.discardIfUntouched(file)).toEqual({ deleted: false });
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe('picked-note grants', () => {
  it('survive a restart through restorePicked', () => {
    const file = path.join(userData, 'kept.md');
    fs.writeFileSync(file, 'x');
    let saved = null;
    notes.onPickedChange((list) => (saved = list));
    notes.allow(file);
    expect(saved).toContain(file);

    notes.restorePicked([]);
    expect(notes.isAllowed(file)).toBe(false);
    notes.restorePicked(saved);
    expect(notes.isAllowed(file)).toBe(true);
    notes.onPickedChange(null);
  });

  it('ignore junk when restored', () => {
    notes.restorePicked(['relative.md', '/etc/hosts', 42, null]);
    expect(notes.isAllowed('/etc/hosts')).toBe(false);
  });

  it('keep only the most recent 50', () => {
    let saved = [];
    notes.onPickedChange((list) => (saved = list));
    notes.restorePicked([]);
    for (let i = 0; i < 55; i++) notes.allow(path.join(userData, `n${i}.md`));
    expect(saved).toHaveLength(50);
    expect(saved[0]).toBe(path.join(userData, 'n5.md'));
    expect(saved.at(-1)).toBe(path.join(userData, 'n54.md'));
    notes.onPickedChange(null);
  });
});
