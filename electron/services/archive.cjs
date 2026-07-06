'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// Zip create/extract via the system binaries that ship with every macOS
// (/usr/bin/zip, /usr/bin/unzip, /usr/bin/ditto) — no bundled archive dep.
// ditto handles UTF-8 filenames and >4GB entries; zip without -y FOLLOWS
// symlinks, which the export engine relies on (it stages a `files` symlink to
// the site directory so site files are never copied before zipping).

const ZIP_BIN = '/usr/bin/zip';
const UNZIP_BIN = '/usr/bin/unzip';
const DITTO_BIN = '/usr/bin/ditto';

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { maxBuffer: 16 * 1024 * 1024, timeout: 0, ...opts },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          reject(err);
        } else {
          resolve(stdout.toString());
        }
      }
    );
  });
}

// Zips the CONTENTS of stagingDir into outZip. No -y: symlinks are followed
// and materialized inside the archive.
async function zipDirectory(stagingDir, outZip) {
  if (fs.existsSync(outZip)) fs.rmSync(outZip);
  await run(ZIP_BIN, ['-r', '-q', outZip, '.', '-x', '*.DS_Store'], {
    cwd: stagingDir,
  });
}

async function listZipEntries(zipFile) {
  const out = await run(UNZIP_BIN, ['-Z1', zipFile]);
  return out.split('\n').filter((l) => l.length > 0);
}

// Reads one entry's contents from a zip without extracting the rest.
async function readZipEntry(zipFile, entryName) {
  return run(UNZIP_BIN, ['-p', zipFile, entryName]);
}

// Zip-slip guard: every entry must stay inside the extraction root. Pure —
// covered by vitest. Throws on the first offending entry.
function assertSafeEntries(entries) {
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error('Archive contains an invalid entry name.');
    }
    if (/[\0\n\r]/.test(entry)) {
      throw new Error('Archive contains an entry with unsafe characters.');
    }
    if (path.isAbsolute(entry) || /^[a-zA-Z]:[\\/]/.test(entry)) {
      throw new Error(`Archive contains an absolute path: ${entry}`);
    }
    const segments = entry.split(/[\\/]/);
    if (segments.includes('..')) {
      throw new Error(`Archive contains a path traversal entry: ${entry}`);
    }
  }
  return true;
}

// Removes any symlink under root whose target resolves outside root.
// Defense-in-depth after extraction: a crafted archive could otherwise drop a
// link pointing at (say) ~/.ssh and have later file operations follow it.
function sweepEscapingSymlinks(root) {
  const rootReal = fs.realpathSync(root);
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) {
        let ok = false;
        try {
          const real = fs.realpathSync(p);
          ok = real === rootReal || real.startsWith(rootReal + path.sep);
        } catch {
          // dangling link — remove it too
        }
        if (!ok) fs.rmSync(p);
      } else if (st.isDirectory()) {
        walk(p);
      }
    }
  };
  walk(rootReal);
}

// Extracts zipFile into destDir (created if needed) after validating every
// entry path. destDir should always be a fresh temp directory — callers move
// content to its final home afterwards.
async function extractZip(zipFile, destDir) {
  assertSafeEntries(await listZipEntries(zipFile));
  fs.mkdirSync(destDir, { recursive: true });
  await run(DITTO_BIN, ['-x', '-k', zipFile, destDir]);
  sweepEscapingSymlinks(destDir);
}

module.exports = {
  zipDirectory,
  listZipEntries,
  readZipEntry,
  assertSafeEntries,
  extractZip,
  sweepEscapingSymlinks,
};
