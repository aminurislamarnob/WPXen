'use strict';

// Directory operations for the Agents project explorer. Every path is confined
// to within a Site's webroot (`rootPath`) so the explorer can never read or
// mutate anything outside the selected project.

const fs = require('fs');
const path = require('path');

// Resolve `target` and guarantee it stays inside `rootPath`. Returns the
// resolved absolute paths; throws if the target escapes the root.
function assertInRoot(rootPath, target) {
  const root = path.resolve(rootPath);
  const resolved = path.resolve(target || rootPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Path is outside the site root');
  }
  return { root, resolved };
}

// Validate a candidate path from terminal output. Resolves relative candidates
// against the site root, confines the result inside the root, and returns
// { exists, isDirectory, resolved }. Never throws — an escape or error is just
// { exists: false } (so links to /etc/hosts etc. simply don't linkify).
function statPath(rootPath, candidate) {
  try {
    if (!candidate || candidate.includes('\0')) return { exists: false };
    const root = path.resolve(rootPath);
    const abs = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(root, candidate);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      return { exists: false };
    }
    const st = fs.statSync(abs);
    return { exists: true, isDirectory: st.isDirectory(), resolved: abs };
  } catch {
    return { exists: false };
  }
}

function listDirectory(rootPath, dirPath) {
  const { resolved: target } = assertInRoot(rootPath, dirPath);

  const dirents = fs.readdirSync(target, { withFileTypes: true });
  const entries = dirents.map((d) => {
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      try {
        isDir = fs.statSync(path.join(target, d.name)).isDirectory();
      } catch {
        isDir = false;
      }
    }
    return { name: d.name, path: path.join(target, d.name), isDir };
  });

  // Folders first, then case-insensitive alpha.
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  return entries;
}

// Reject names that would traverse or escape the parent directory.
function assertSimpleName(name) {
  const trimmed = (name || '').trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') {
    throw new Error('Invalid name');
  }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
    throw new Error('Name cannot contain path separators');
  }
  return trimmed;
}

function createFile(rootPath, dirPath, name) {
  const { resolved: dir } = assertInRoot(rootPath, dirPath);
  const clean = assertSimpleName(name);
  const target = path.join(dir, clean);
  assertInRoot(rootPath, target);
  if (fs.existsSync(target)) throw new Error('A file with that name already exists');
  fs.writeFileSync(target, '', { flag: 'wx' });
  return { path: target };
}

function createFolder(rootPath, dirPath, name) {
  const { resolved: dir } = assertInRoot(rootPath, dirPath);
  const clean = assertSimpleName(name);
  const target = path.join(dir, clean);
  assertInRoot(rootPath, target);
  if (fs.existsSync(target)) throw new Error('A folder with that name already exists');
  fs.mkdirSync(target);
  return { path: target };
}

// Read a text file for the in-app editor. Confined to the site root, size-capped,
// and binary files are refused (so we never dump megabytes of bytes into React).
const MAX_READ_BYTES = 2 * 1024 * 1024; // 2 MB

function readFile(rootPath, filePath) {
  const { root, resolved } = assertInRoot(rootPath, filePath);
  if (resolved === root) throw new Error('Not a file');
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) throw new Error('Not a file');
  if (stat.size > MAX_READ_BYTES) {
    return { tooLarge: true, size: stat.size };
  }
  const buf = fs.readFileSync(resolved);
  // Treat a NUL byte in the first 8 KB as a binary sniff.
  if (buf.subarray(0, 8192).includes(0)) {
    return { binary: true, size: stat.size };
  }
  return { content: buf.toString('utf8'), size: stat.size };
}

// Write edited text back to a file. Confined to the site root; refuses to
// create new paths (the file must already exist) and rejects directories.
function writeFile(rootPath, filePath, content) {
  const { root, resolved } = assertInRoot(rootPath, filePath);
  if (resolved === root) throw new Error('Not a file');
  const stat = fs.statSync(resolved); // throws if missing
  if (stat.isDirectory()) throw new Error('Not a file');
  fs.writeFileSync(resolved, content, 'utf8');
  return { path: resolved };
}

// Find a non-colliding path in `dir` for `name`, appending " 2", " 3", …
// before the extension (Finder-style) so an import never overwrites.
function uniqueDest(dir, name) {
  let candidate = path.join(dir, name);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 2; i < 1000; i++) {
    candidate = path.join(dir, `${stem} ${i}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Too many name conflicts');
}

// Copy external files/folders (dragged from Finder) into a directory under the
// site root. The destination is confined to the root and never overwrites; the
// sources may live anywhere (the user dropped them). Returns created entries.
function importFiles(rootPath, dirPath, sourcePaths) {
  const { resolved: dir } = assertInRoot(rootPath, dirPath);
  if (!fs.statSync(dir).isDirectory()) throw new Error('Not a directory');

  const created = [];
  for (const src of sourcePaths || []) {
    if (typeof src !== 'string' || !src) continue;
    const base = assertSimpleName(path.basename(src));
    const dest = uniqueDest(dir, base);
    assertInRoot(rootPath, dest);
    fs.cpSync(src, dest, { recursive: true, errorOnExist: true, force: false });
    created.push({ path: dest, name: path.basename(dest) });
  }
  return { imported: created };
}

function renamePath(rootPath, targetPath, newName) {
  const { root, resolved: src } = assertInRoot(rootPath, targetPath);
  if (src === root) throw new Error('Cannot rename the site root');
  const clean = assertSimpleName(newName);
  const dest = path.join(path.dirname(src), clean);
  assertInRoot(rootPath, dest);
  if (dest === src) return { path: dest };
  if (fs.existsSync(dest)) throw new Error('A file with that name already exists');
  fs.renameSync(src, dest);
  return { path: dest };
}

const { execFile } = require('child_process');
const { promisify } = require('util');
const listFilesCache = new Map();
const LIST_SKIP_DIRS = new Set(['node_modules', 'vendor', '.git']);

async function gitListFiles(root, limit) {
  const { stdout } = await promisify(execFile)(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  );
  return stdout.split(/\r?\n/).filter(Boolean).slice(0, limit);
}

async function walkFiles(root, limit) {
  const files = [];
  const queue = [root];
  while (queue.length > 0 && files.length < limit) {
    const dir = queue.shift();
    let dirents;
    try {
      dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // inaccessible
    }
    for (const d of dirents) {
      const full = path.join(dir, d.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (d.isDirectory()) {
        if (!LIST_SKIP_DIRS.has(d.name) && rel !== 'wp-content/uploads') queue.push(full);
      } else if (d.isFile()) {
        files.push(rel);
        if (files.length >= limit) break;
      }
    }
  }
  return files;
}

// Every file under a Site, for the chat composer's @ mentions: git's view
// (tracked + untracked, minus .gitignore) in a repo, else a bounded walk.
// Async — a large repo must not stall the main process. Cached 30 s.
async function listFiles(rootPath, { limit = 20000 } = {}) {
  const root = path.resolve(rootPath);
  const cached = listFilesCache.get(root);
  if (cached && Date.now() - cached.time < 30000) return cached.files;

  let files = [];
  try {
    files = fs.existsSync(path.join(root, '.git'))
      ? await gitListFiles(root, limit)
      : await walkFiles(root, limit);
  } catch {
    files = await walkFiles(root, limit).catch(() => []);
  }
  listFilesCache.set(root, { time: Date.now(), files });
  return files;
}

module.exports = {
  listFiles,
  assertInRoot,
  statPath,
  listDirectory,
  readFile,
  writeFile,
  createFile,
  createFolder,
  renamePath,
  importFiles,
};
