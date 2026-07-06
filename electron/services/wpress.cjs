'use strict';

const fs = require('fs');
const path = require('path');

// Pure-Node reader for All-in-One WP Migration `.wpress` archives. The format
// is a flat sequence of [header][content] blocks:
//
//   header = 4377 bytes
//     [0,    255)  filename       ASCII, NUL-padded
//     [255,  269)  content size   ASCII decimal, NUL-padded
//     [269,  281)  mtime          ASCII decimal, NUL-padded
//     [281, 4377)  directory      relative dir prefix, NUL-padded
//   content = `size` raw bytes immediately after the header
//
// End of archive = a header block of all NUL bytes. The payload is wp-content
// only (plugins/, themes/, uploads/, mu-plugins/, …) plus `database.sql` and
// `package.json` at the root — no WP core, no wp-config.php.

const HEADER_SIZE = 4377;
const NAME_END = 255;
const SIZE_END = 269;
const MTIME_END = 281;

const PARSE_ERROR =
  'This .wpress file could not be parsed. It may be corrupted or use an unsupported version of the All-in-One WP Migration format.';

function readField(buf, start, end) {
  const nul = buf.indexOf(0, start);
  const stop = nul === -1 || nul > end ? end : nul;
  return buf.toString('utf8', start, stop);
}

// Parses one 4377-byte header. Returns null for the EOF terminator block;
// throws on anything malformed. Pure — covered by vitest.
//
// A real file entry always carries a filename, so an empty name field marks
// the end of the archive. Two terminator variants exist and both must be
// treated as EOF: v1 archives write an all-NUL block, while newer (v2)
// All-in-One WP Migration archives write an empty name plus the archive CRC
// size/value in the size and trailing crc32 fields — a non-NUL block that an
// all-NUL test alone would reject as corrupt (the historical bug here).
function parseWpressHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== HEADER_SIZE) {
    throw new Error(PARSE_ERROR);
  }

  const name = readField(buf, 0, NAME_END);
  if (name === '') return null; // EOF block (v1 all-NUL or v2 CRC terminator)

  const sizeStr = readField(buf, NAME_END, SIZE_END);
  const mtimeStr = readField(buf, SIZE_END, MTIME_END);
  const dir = readField(buf, MTIME_END, HEADER_SIZE);

  const size = Number(sizeStr);
  if (sizeStr === '' || !Number.isInteger(size) || size < 0) {
    throw new Error(PARSE_ERROR);
  }
  return { name, size, mtime: Number(mtimeStr) || 0, dir };
}

// Joins a header's dir + name into a safe relative path. Throws on anything
// that would escape the extraction root. Pure — covered by vitest.
function sanitizeWpressPath(dir, name) {
  const raw = dir && dir !== '.' ? `${dir}/${name}` : name;
  if (/[\0\n\r]/.test(raw)) {
    throw new Error('Archive contains an entry with unsafe characters.');
  }
  if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) {
    throw new Error(`Archive contains an absolute path: ${raw}`);
  }
  const rel = path.normalize(raw);
  if (rel.split(path.sep).includes('..')) {
    throw new Error(`Archive contains a path traversal entry: ${raw}`);
  }
  return rel;
}

// All-in-One WP Migration dumps use this token where the real table prefix
// belongs; replace it during the import rewrite. Pure — covered by vitest.
const SERVMASK_TOKEN = 'SERVMASK_PREFIX_';
function replaceServmaskPrefix(line, prefix = 'wp_') {
  return line.split(SERVMASK_TOKEN).join(prefix);
}

function sqlContainsServmaskPrefix(sqlFile) {
  // The CREATE TABLE statements appear early; 1MB is more than enough to know.
  const fd = fs.openSync(sqlFile, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8', 0, read).includes(SERVMASK_TOKEN);
  } finally {
    fs.closeSync(fd);
  }
}

// Rewrites database.sql line-buffered, replacing the SERVMASK prefix token.
// Returns the path of the rewritten file (a sibling of the original).
async function rewriteServmaskSql(sqlFile, prefix = 'wp_') {
  const outFile = `${sqlFile}.rewritten.sql`;
  const readline = require('readline');
  const input = fs.createReadStream(sqlFile);
  const output = fs.createWriteStream(outFile);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    output.write(replaceServmaskPrefix(line, prefix) + '\n');
  }
  await new Promise((resolve, reject) => {
    output.end(() => resolve());
    output.on('error', reject);
  });
  return outFile;
}

// Reads a single small root-level entry (e.g. package.json) by walking the
// header chain and seeking over content — no extraction needed.
function readWpressEntry(file, entryName, { maxBytes = 4 * 1024 * 1024 } = {}) {
  const fd = fs.openSync(file, 'r');
  const header = Buffer.alloc(HEADER_SIZE);
  let offset = 0;
  try {
    const total = fs.fstatSync(fd).size;
    for (;;) {
      const read = fs.readSync(fd, header, 0, HEADER_SIZE, offset);
      if (read === 0) return null;
      if (read !== HEADER_SIZE) throw new Error(PARSE_ERROR);
      const entry = parseWpressHeader(header);
      if (entry === null) return null;
      offset += HEADER_SIZE;
      if (offset + entry.size > total) throw new Error(PARSE_ERROR);
      if (entry.name === entryName && (!entry.dir || entry.dir === '.')) {
        if (entry.size > maxBytes) throw new Error(PARSE_ERROR);
        const buf = Buffer.alloc(entry.size);
        let done = 0;
        while (done < entry.size) {
          const n = fs.readSync(fd, buf, done, entry.size - done, offset + done);
          if (n <= 0) throw new Error(PARSE_ERROR);
          done += n;
        }
        return buf;
      }
      offset += entry.size;
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Extracts a .wpress archive into destDir, streaming each entry's bytes from
// the source file. Never loads whole entries into memory.
async function extractWpress(file, destDir, { onProgress } = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  const fd = fs.openSync(file, 'r');
  const header = Buffer.alloc(HEADER_SIZE);
  let offset = 0;
  let count = 0;
  try {
    const total = fs.fstatSync(fd).size;
    for (;;) {
      const read = fs.readSync(fd, header, 0, HEADER_SIZE, offset);
      if (read === 0) break; // clean EOF without marker — tolerate
      if (read !== HEADER_SIZE) throw new Error(PARSE_ERROR);
      const entry = parseWpressHeader(header);
      if (entry === null) break; // EOF marker
      offset += HEADER_SIZE;
      if (offset + entry.size > total) throw new Error(PARSE_ERROR);

      const rel = sanitizeWpressPath(entry.dir, entry.name);
      const dest = path.join(destDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });

      const out = fs.createWriteStream(dest);
      let remaining = entry.size;
      const chunk = Buffer.alloc(Math.min(1024 * 1024, Math.max(remaining, 1)));
      while (remaining > 0) {
        const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, remaining), offset);
        if (n <= 0) throw new Error(PARSE_ERROR);
        // subarray shares memory with `chunk`; copy so queued writes are stable
        if (!out.write(Buffer.from(chunk.subarray(0, n)))) {
          await new Promise((resolve) => out.once('drain', resolve));
        }
        offset += n;
        remaining -= n;
      }
      await new Promise((resolve, reject) => {
        out.end(() => resolve());
        out.on('error', reject);
      });
      count += 1;
      if (onProgress && count % 200 === 0) {
        onProgress({ files: count });
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return { files: count };
}

module.exports = {
  HEADER_SIZE,
  parseWpressHeader,
  sanitizeWpressPath,
  replaceServmaskPrefix,
  sqlContainsServmaskPrefix,
  rewriteServmaskSql,
  readWpressEntry,
  extractWpress,
};
