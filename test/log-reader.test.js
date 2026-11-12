import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  readPage,
  countLevels,
  countLevelsAsync,
  PAGE_MAX_ENTRIES,
  PAGE_MAX_BYTES,
  ENTRY_MAX_BYTES,
  PAGE_SCAN_BYTES,
} from '../electron/services/logReader.cjs';

// Fixtures copy the line shapes PHP, PHP-FPM and nginx really write; every
// path, message, pid and date is invented.

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-logs-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(name, text) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text);
  return p;
}

const FATAL_WITH_TRACE = [
  '[12-Nov-2026 10:00:02 UTC] PHP Fatal error:  Uncaught Exception: Widget missing in /srv/demo/wp-content/plugins/acme/acme.php:12',
  'Stack trace:',
  '#0 /srv/demo/wp-includes/class-wp-hook.php(324): acme_boot()',
  '#1 {main}',
  '  thrown in /srv/demo/wp-content/plugins/acme/acme.php on line 12',
].join('\n');

describe('readPage: entries', () => {
  it('keeps a PHP fatal and its whole stack trace in one entry', () => {
    const p = fixture(
      'debug.log',
      [
        '[12-Nov-2026 10:00:01 UTC] PHP Deprecated:  Function old_thing is deprecated in /srv/demo/a.php on line 3',
        FATAL_WITH_TRACE,
        '[12-Nov-2026 10:00:03 UTC] PHP Notice:  Undefined index: id in /srv/demo/b.php on line 9',
        '',
      ].join('\n')
    );

    const page = readPage(p, 'debug');

    expect(page.exists).toBe(true);
    expect(page.atStart).toBe(true);
    expect(page.entries).toHaveLength(3);
    const fatal = page.entries[1];
    expect(fatal.time).toBe('12-Nov-2026 10:00:02 UTC');
    expect(fatal.level).toBe('fatal');
    expect(fatal.text).toBe(FATAL_WITH_TRACE.replace('[12-Nov-2026 10:00:02 UTC] ', ''));
  });

  it('reports a missing file as not existing, with no entries', () => {
    const page = readPage(path.join(dir, 'nope.log'), 'debug');
    expect(page).toMatchObject({ exists: false, size: 0, entries: [], atStart: true });
  });
});

describe('readPage: levels', () => {
  const levels = (p, kind) => readPage(p, kind).entries.map((e) => e.level);

  it('normalises the WordPress debug log', () => {
    const p = fixture(
      'debug.log',
      [
        '[12-Nov-2026 10:00:01 UTC] PHP Fatal error:  Allowed memory size exhausted in /srv/demo/a.php on line 1',
        '[12-Nov-2026 10:00:02 UTC] PHP Parse error:  syntax error, unexpected token "}" in /srv/demo/b.php on line 2',
        '[12-Nov-2026 10:00:03 UTC] PHP Warning:  Undefined variable $x in /srv/demo/c.php on line 3',
        '[12-Nov-2026 10:00:04 UTC] PHP Notice:  Function f was called incorrectly. in /srv/demo/d.php on line 4',
        '[12-Nov-2026 10:00:05 UTC] PHP Deprecated:  Creation of dynamic property is deprecated in /srv/demo/e.php on line 5',
        '[12-Nov-2026 10:00:06 UTC] WordPress database error Table demo.wp_acme does not exist for query SELECT 1',
        '[12-Nov-2026 10:00:07 UTC] acme: cache warmed',
        '',
      ].join('\n')
    );
    expect(levels(p, 'debug')).toEqual([
      'fatal',
      'fatal',
      'warning',
      'notice',
      'deprecated',
      'other',
      'other',
    ]);
  });

  it('normalises the PHP-FPM log, preferring a quoted PHP message', () => {
    const p = fixture(
      'php-fpm.log',
      [
        '[29-Oct-2026 00:48:32] NOTICE: fpm is running, pid 4242',
        '[29-Oct-2026 00:48:33] WARNING: [pool wpxen-8.4] server reached pm.max_children setting (5), consider raising it',
        "[29-Oct-2026 00:48:34] ERROR: unable to bind listening socket for address '/opt/demo/php8.4-fpm.sock': Address already in use (48)",
        '[29-Oct-2026 00:48:35] ALERT: [pool wpxen-8.3] child 4250 exited on signal 11 (SIGSEGV) after 3.000000 seconds from start',
        '[29-Oct-2026 00:48:36] WARNING: [pool wpxen-8.4] child 4251 said into stderr: "PHP Deprecated:  strlen(): Passing null is deprecated"',
        '[29-Oct-2026 00:48:37] DEBUG: pid 4242, fpm_scoreboard_update(), line 120',
        '[29-Oct-2026 00:48:38 UTC] PHP Fatal error:  Uncaught Error: Call to undefined function acme() in /srv/demo/x.php:3',
        '',
      ].join('\n')
    );
    const page = readPage(p, 'php-error');
    expect(page.entries.map((e) => e.level)).toEqual([
      'notice',
      'warning',
      'fatal',
      'fatal',
      'deprecated',
      'other',
      'fatal',
    ]);
    expect(page.entries[0]).toMatchObject({
      time: '29-Oct-2026 00:48:32',
      text: 'NOTICE: fpm is running, pid 4242',
    });
  });

  it('normalises the nginx error log, letting a relayed PHP message decide', () => {
    const p = fixture(
      'demo.test.error.log',
      [
        '2026/06/26 02:17:16 [crit] 19713#0: *1 connect() to unix:/opt/demo/php8.5-fpm.sock failed (2: No such file or directory) while connecting to upstream, client: 127.0.0.1, server: demo.test, request: "GET / HTTP/1.1", upstream: "fastcgi://unix:/opt/demo/php8.5-fpm.sock:", host: "demo.test"',
        '2026/06/26 02:17:17 [error] 19713#0: *2 upstream timed out (60: Operation timed out) while reading response header from upstream, client: 127.0.0.1, server: demo.test',
        '2026/06/26 02:17:18 [error] 19713#0: *3 FastCGI sent in stderr: "PHP message: PHP Deprecated:  Return type should be compatible; PHP message: PHP Warning:  Undefined array key "slug" in /srv/demo/f.php on line 8" while reading response header from upstream, client: 127.0.0.1',
        '2026/06/26 02:17:19 [warn] 19713#0: *4 an upstream response is buffered to a temporary file',
        '2026/06/26 02:17:20 [notice] 19700#0: signal process started',
        '2026/06/26 02:17:21 [info] 19713#0: *5 client closed keepalive connection',
        '2026/06/26 02:17:22 [emerg] 19700#0: bind() to 127.0.0.1:80 failed (48: Address already in use)',
        '',
      ].join('\n')
    );
    const page = readPage(p, 'nginx-error');
    expect(page.entries.map((e) => e.level)).toEqual([
      'fatal',
      'fatal',
      'warning',
      'warning',
      'notice',
      'notice',
      'fatal',
    ]);
    expect(page.entries[4]).toMatchObject({
      time: '2026/06/26 02:17:20',
      text: '[notice] 19700#0: signal process started',
    });
  });

  it('reads the nginx access log as one entry per line with no level', () => {
    const lines = [
      '127.0.0.1 - - [12/Nov/2026:10:00:00 +0000] "GET / HTTP/1.1" 200 5120 "-" "Mozilla/5.0 (Macintosh)"',
      '127.0.0.1 - - [12/Nov/2026:10:00:01 +0000] "POST /wp-admin/admin-ajax.php HTTP/1.1" 400 1 "https://demo.test/wp-admin/" "Mozilla/5.0 (Macintosh)"',
      '127.0.0.1 - - [12/Nov/2026:10:00:02 +0000] "GET /favicon.ico HTTP/1.1" 302 0 "-" "Mozilla/5.0 (Macintosh)"',
    ];
    const p = fixture('demo.test.access.log', lines.join('\n') + '\n');
    const page = readPage(p, 'nginx-access');
    expect(page.entries).toEqual([
      { offset: 0, time: '12/Nov/2026:10:00:00 +0000', level: null, text: lines[0] },
      {
        offset: lines[0].length + 1,
        time: '12/Nov/2026:10:00:01 +0000',
        level: null,
        text: lines[1],
      },
      {
        offset: lines[0].length + lines[1].length + 2,
        time: '12/Nov/2026:10:00:02 +0000',
        level: null,
        text: lines[2],
      },
    ]);
  });

  it('rejects an unknown log kind', () => {
    const p = fixture('x.log', 'hello\n');
    expect(() => readPage(p, 'syslog')).toThrow(/Unknown log type/);
  });
});

// Writes `count` debug-log entries and returns the file with what each entry
// should read back as: every 7th a fatal with a stack trace of a varying
// number of frames, the rest deprecation notices.
function bigDebugLog(name, count, { frames = 3 } = {}) {
  const expected = [];
  const parts = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const mm = String(Math.floor(i / 60) % 60).padStart(2, '0');
    const ss = String(i % 60).padStart(2, '0');
    const time = `12-Nov-2026 10:${mm}:${ss} UTC`;
    let text;
    if (i % 7 === 0) {
      const trace = Array.from(
        { length: frames + (i % 5) },
        (_, f) =>
          `#${f} /srv/demo/wp-includes/frame-${i}-${f}.php(${f + 10}): step_${f}()`
      );
      text = [
        `PHP Fatal error:  Uncaught Error: entry ${i} in /srv/demo/x.php:${i}`,
        'Stack trace:',
        ...trace,
        `  thrown in /srv/demo/x.php on line ${i}`,
      ].join('\n');
    } else {
      text = `PHP Deprecated:  Function legacy_${i}() is deprecated in /srv/demo/y.php on line ${i}`;
    }
    const raw = `[${time}] ${text}\n`;
    expected.push({ offset, time, text });
    parts.push(raw);
    offset += Buffer.byteLength(raw);
  }
  return { path: fixture(name, parts.join('')), expected, size: offset };
}

// Pages from the newest back to the first entry; returns every page.
function pageToStart(p, kind, opts = {}) {
  const pages = [readPage(p, kind, opts)];
  while (!pages[pages.length - 1].atStart) {
    pages.push(readPage(p, kind, { ...opts, end: pages[pages.length - 1].pageStart }));
    if (pages.length > 10_000) throw new Error('paging never reached the start');
  }
  return pages;
}

describe('readPage: paging', () => {
  it('returns the newest page by default, ending at the end of the file', () => {
    const { path: p, expected, size } = bigDebugLog('debug.log', 2000);
    const page = readPage(p, 'debug');
    expect(page.size).toBe(size);
    expect(page.end).toBe(size);
    expect(page.atStart).toBe(false);
    expect(page.entries.length).toBeGreaterThan(0);
    expect(page.entries.length).toBeLessThan(expected.length);
    expect(page.entries[page.entries.length - 1].text).toBe(
      expected[expected.length - 1].text
    );
  });

  it('starts every page on an entry start', () => {
    const { path: p, expected } = bigDebugLog('debug.log', 2000);
    const starts = new Set(expected.map((e) => e.offset));
    for (const page of pageToStart(p, 'debug')) {
      expect(page.entries[0].offset).toBe(page.pageStart);
      expect(starts.has(page.pageStart)).toBe(true);
    }
  });

  it('pages back to the first entry without splitting or repeating one', () => {
    const { path: p, expected } = bigDebugLog('debug.log', 5000);
    const pages = pageToStart(p, 'debug');
    expect(pages.length).toBeGreaterThan(3);

    const all = pages.reverse().flatMap((page) => page.entries);
    expect(all.map(({ offset, time, text }) => ({ offset, time, text }))).toEqual(
      expected
    );
    expect(all.some((e) => e.partial)).toBe(false);
  });

  it('bounds a page by the text it carries, not just its entry count', () => {
    // ~40 KB stack traces: a page fills its byte budget long before 500 entries.
    const { path: p, expected } = bigDebugLog('debug.log', 300, { frames: 600 });
    const pages = pageToStart(p, 'debug');
    for (const page of pages) {
      const bytes = page.entries.reduce((n, e) => n + Buffer.byteLength(e.text), 0);
      expect(bytes).toBeLessThan(PAGE_MAX_BYTES + ENTRY_MAX_BYTES);
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.reverse().flatMap((page) => page.entries).length).toBe(expected.length);
  });

  it('clamps an end beyond the file (it shrank since) to its size', () => {
    const p = fixture('debug.log', '[12-Nov-2026 10:00:00 UTC] PHP Notice:  one\n');
    const page = readPage(p, 'debug', { end: 10_000 });
    expect(page.end).toBe(page.size);
    expect(page.entries).toHaveLength(1);
  });

  it('cuts a run of header-less lines longer than an entry into partial parts', () => {
    const line = 'x'.repeat(99) + '\n';
    const count = Math.ceil((ENTRY_MAX_BYTES * 2.5) / line.length);
    const p = fixture(
      'debug.log',
      '[12-Nov-2026 10:00:00 UTC] PHP Warning:  dump follows\n' + line.repeat(count)
    );
    const all = pageToStart(p, 'debug')
      .reverse()
      .flatMap((page) => page.entries);

    expect(all.length).toBeGreaterThan(2);
    expect(all[0]).toMatchObject({ offset: 0, level: 'warning' });
    expect(all[0].partial).toBeUndefined();
    for (const e of all.slice(1)) {
      expect(e).toMatchObject({ partial: true, time: null, level: 'other' });
      expect(Buffer.byteLength(e.text)).toBeLessThanOrEqual(ENTRY_MAX_BYTES);
    }
    // Together the parts are the whole file, in order, nothing repeated.
    const joined = all
      .map((e, i) => (i === 0 ? `[${e.time}] ${e.text}` : e.text))
      .join('\n');
    expect(joined + '\n').toBe(fs.readFileSync(p, 'utf8'));
  });
});

describe('readPage: level filter', () => {
  it('returns only entries of the levels asked for', () => {
    const p = fixture('debug.log', KNOWN_MIX);
    const page = readPage(p, 'debug', { levels: ['fatal', 'warning'] });
    expect(page.entries.map((e) => e.level)).toEqual([
      'warning',
      'fatal',
      'warning',
      'fatal',
      'warning',
    ]);
    expect(page.atStart).toBe(true);
  });

  it('keeps each fatal whole, with its full stack trace', () => {
    const p = fixture('debug.log', KNOWN_MIX);
    const [fatal] = readPage(p, 'debug', { levels: ['fatal'] }).entries;
    expect(fatal).toMatchObject({ time: '12-Nov-2026 10:00:02 UTC', level: 'fatal' });
    expect(fatal.text).toBe(FATAL_WITH_TRACE.replace('[12-Nov-2026 10:00:02 UTC] ', ''));
  });

  it('pages back to the start while filtered, never returning a hidden level', () => {
    const { path: p, expected } = bigDebugLog('debug.log', 5000);
    const pages = pageToStart(p, 'debug', { levels: ['fatal'] });
    expect(pages.length).toBeGreaterThan(1);

    const all = pages.reverse().flatMap((page) => page.entries);
    expect(all.every((e) => e.level === 'fatal')).toBe(true);
    // Exactly the file's fatals, in order, each once and with its trace.
    expect(all.map(({ offset, time, text }) => ({ offset, time, text }))).toEqual(
      expected.filter((e) => e.text.startsWith('PHP Fatal error:'))
    );
  });

  it('hides deprecations while showing everything else', () => {
    const p = fixture('debug.log', KNOWN_MIX);
    const page = readPage(p, 'debug', {
      levels: ['fatal', 'warning', 'notice', 'other'],
    });
    expect(page.entries).toHaveLength(8);
    expect(page.entries.some((e) => e.level === 'deprecated')).toBe(false);
  });

  it('bounds how far one filtered page scans, so a rare level never reads the whole file', () => {
    // Only deprecations: a fatal-only page finds nothing and must stop early.
    const p = path.join(dir, 'debug.log');
    const line = `[12-Nov-2026 10:00:00 UTC] PHP Deprecated:  Function legacy() is deprecated in /srv/demo/y.php on line 1\n`;
    const block = Buffer.from(line.repeat(Math.ceil((1024 * 1024) / line.length)));
    const fd = fs.openSync(p, 'w');
    for (let written = 0; written < PAGE_SCAN_BYTES * 3; written += block.length) {
      fs.writeSync(fd, block);
    }
    fs.closeSync(fd);

    const page = readPage(p, 'debug', { levels: ['fatal'] });
    expect(page.entries).toEqual([]);
    expect(page.atStart).toBe(false);
    expect(page.end - page.pageStart).toBeGreaterThanOrEqual(PAGE_SCAN_BYTES);
    expect(page.end - page.pageStart).toBeLessThan(PAGE_SCAN_BYTES + ENTRY_MAX_BYTES);
    // …and the next page carries on from there, still on an entry start.
    const next = readPage(p, 'debug', { levels: ['fatal'], end: page.pageStart });
    expect(next.end).toBe(page.pageStart);
    expect(next.pageStart % line.length).toBe(0);
  });

  it('ignores a level filter on the access log, which has no levels', () => {
    const p = fixture(
      'demo.test.access.log',
      '127.0.0.1 - - [12/Nov/2026:10:00:00 +0000] "GET / HTTP/1.1" 200 5120 "-" "Mozilla/5.0"\n'
    );
    expect(readPage(p, 'nginx-access', { levels: ['fatal'] }).entries).toHaveLength(1);
  });
});

describe('readPage: large files', () => {
  it('opens the newest page of a 200 MB debug log in under a second', () => {
    const p = path.join(dir, 'debug.log');
    const block = Buffer.from(
      Array.from(
        { length: 4096 },
        (_, i) =>
          `[12-Nov-2026 10:00:00 UTC] PHP Deprecated:  Function legacy_${i}() is deprecated in /srv/demo/y.php on line ${i}\n`
      ).join('')
    );
    const fd = fs.openSync(p, 'w');
    for (let written = 0; written < 200 * 1024 * 1024; written += block.length) {
      fs.writeSync(fd, block);
    }
    fs.closeSync(fd);

    const started = performance.now();
    const page = readPage(p, 'debug');
    expect(performance.now() - started).toBeLessThan(1000);
    expect(page.entries.length).toBe(PAGE_MAX_ENTRIES);
  });

  it('opens a 200 MB file with no newline at all without scanning it', () => {
    const p = path.join(dir, 'debug.log');
    const fd = fs.openSync(p, 'w');
    fs.ftruncateSync(fd, 200 * 1024 * 1024); // sparse: one 200 MB "line"
    fs.closeSync(fd);

    const started = performance.now();
    const page = readPage(p, 'debug');
    expect(performance.now() - started).toBeLessThan(1000);
    expect(page.entries.length).toBeGreaterThan(0);
    expect(page.atStart).toBe(false);
  });
});

// A debug log with a known mix: 2 fatals (one with a stack trace), 3
// warnings, 1 notice, 4 deprecations and 2 plain WordPress lines.
const KNOWN_MIX = [
  '[12-Nov-2026 10:00:01 UTC] PHP Deprecated:  Function a() is deprecated in /srv/demo/a.php on line 1',
  '[12-Nov-2026 10:00:02 UTC] PHP Warning:  Undefined variable $x in /srv/demo/c.php on line 3',
  FATAL_WITH_TRACE,
  '[12-Nov-2026 10:00:03 UTC] PHP Deprecated:  Function b() is deprecated in /srv/demo/a.php on line 2',
  '[12-Nov-2026 10:00:04 UTC] WordPress database error Table demo.wp_acme does not exist',
  '[12-Nov-2026 10:00:05 UTC] PHP Notice:  Function f was called incorrectly. in /srv/demo/d.php on line 4',
  '[12-Nov-2026 10:00:06 UTC] PHP Warning:  Undefined array key "slug" in /srv/demo/f.php on line 8',
  '[12-Nov-2026 10:00:07 UTC] PHP Deprecated:  Function c() is deprecated in /srv/demo/a.php on line 3',
  '[12-Nov-2026 10:00:08 UTC] PHP Parse error:  syntax error, unexpected token "}" in /srv/demo/b.php on line 2',
  '[12-Nov-2026 10:00:09 UTC] acme: cache warmed',
  '[12-Nov-2026 10:00:10 UTC] PHP Warning:  Division by zero in /srv/demo/g.php on line 9',
  '[12-Nov-2026 10:00:11 UTC] PHP Deprecated:  Function d() is deprecated in /srv/demo/a.php on line 4',
  '',
].join('\n');

describe('countLevels', () => {
  it('counts the entries of each level in a file with a known mix', () => {
    const p = fixture('debug.log', KNOWN_MIX);
    expect(countLevels(p, 'debug')).toEqual({
      path: p,
      exists: true,
      size: Buffer.byteLength(KNOWN_MIX),
      counts: { fatal: 2, warning: 3, notice: 1, deprecated: 4, other: 2 },
    });
  });

  it('counts the whole file, not just its newest page', () => {
    // 5000 entries, every 7th a fatal with a trace: 715 fatals, 4285 deprecations.
    const { path: p } = bigDebugLog('debug.log', 5000);
    expect(countLevels(p, 'debug').counts).toEqual({
      fatal: 715,
      warning: 0,
      notice: 0,
      deprecated: 4285,
      other: 0,
    });
  });

  it('counts the nginx error log by its normalised levels', () => {
    const p = fixture(
      'demo.test.error.log',
      [
        '2026/06/26 02:17:16 [crit] 19713#0: *1 connect() to unix:/opt/demo/php8.5-fpm.sock failed (2: No such file or directory)',
        '2026/06/26 02:17:18 [error] 19713#0: *3 FastCGI sent in stderr: "PHP message: PHP Deprecated:  Return type should be compatible"',
        '2026/06/26 02:17:19 [warn] 19713#0: *4 an upstream response is buffered to a temporary file',
        '',
      ].join('\n')
    );
    expect(countLevels(p, 'nginx-error').counts).toEqual({
      fatal: 1,
      warning: 1,
      notice: 0,
      deprecated: 1,
      other: 0,
    });
  });

  it('has no counts for the access log, which has no levels', () => {
    const p = fixture(
      'demo.test.access.log',
      '127.0.0.1 - - [12/Nov/2026:10:00:00 +0000] "GET / HTTP/1.1" 200 5120 "-" "Mozilla/5.0"\n'
    );
    expect(countLevels(p, 'nginx-access')).toMatchObject({ exists: true, counts: null });
  });

  it('counts each level exactly as many rows as filtered paging shows', () => {
    const { path: p } = bigDebugLog('debug.log', 3000);
    const { counts } = countLevels(p, 'debug');
    for (const level of ['fatal', 'deprecated']) {
      const shown = pageToStart(p, 'debug', { levels: [level] }).flatMap(
        (pg) => pg.entries
      );
      expect(shown.length).toBe(counts[level]);
    }
  });

  it('reports a missing file as not existing, with zero counts', () => {
    expect(countLevels(path.join(dir, 'nope.log'), 'debug')).toMatchObject({
      exists: false,
      size: 0,
      counts: { fatal: 0, warning: 0, notice: 0, deprecated: 0, other: 0 },
    });
  });
});

// The longest stretch the event loop went without a turn while `work` ran:
// a timer that should fire every few ms records how late each tick is.
async function longestStall(work) {
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 2);
  try {
    const result = await work();
    worst = Math.max(worst, performance.now() - last);
    return { result, worst };
  } finally {
    clearInterval(timer);
  }
}

// Story 54: counting a big log must not freeze the main process, where every
// IPC reply and every Agent terminal's output waits on the same event loop.
describe('countLevelsAsync', () => {
  it('counts exactly what countLevels counts, however finely it is sliced', async () => {
    const { path: p } = bigDebugLog('debug.log', 5000);
    // A slice budget of 0 yields at every check, so the walk is resumed many
    // times — each resume must pick up at the same entry boundary.
    expect(await countLevelsAsync(p, 'debug', { sliceMs: 0, cache: false })).toEqual(
      countLevels(p, 'debug')
    );
  });

  it('resumes inside a long header-less run without changing how it splits', async () => {
    const run = Array.from({ length: 30_000 }, (_, i) => `  continued line ${i}`).join(
      '\n'
    );
    const p = fixture(
      'debug.log',
      `${KNOWN_MIX}\n${run}\n[12-Nov-2026 11:00:00 UTC] PHP Warning:  after the run\n`
    );
    const sliced = await countLevelsAsync(p, 'debug', { sliceMs: 0, cache: false });
    expect(sliced).toEqual(countLevels(p, 'debug'));
    expect(sliced.counts.other).toBeGreaterThan(2); // the run was cut into parts
  });

  it('keeps the event loop turning while it counts a large file', async () => {
    const p = path.join(dir, 'debug.log');
    const { path: src } = bigDebugLog('seed.log', 20_000);
    const block = fs.readFileSync(src);
    const fd = fs.openSync(p, 'w');
    for (let written = 0; written < 48 * 1024 * 1024; written += block.length) {
      fs.writeSync(fd, block);
    }
    fs.closeSync(fd);

    const { result, worst } = await longestStall(() =>
      countLevelsAsync(p, 'debug', { cache: false })
    );
    expect(result.counts).toEqual(countLevels(p, 'debug').counts);
    expect(worst).toBeLessThan(100);
  });

  it('answers an unchanged file again from its last count, and recounts once it changes', async () => {
    const p = fixture('debug.log', KNOWN_MIX + '\n');
    const first = await countLevelsAsync(p, 'debug');
    expect(await countLevelsAsync(p, 'debug')).toEqual(first);

    fs.appendFileSync(p, '[12-Nov-2026 11:00:00 UTC] PHP Fatal error:  appended\n');
    const after = await countLevelsAsync(p, 'debug');
    expect(after.counts.fatal).toBe(first.counts.fatal + 1);
    expect(after.size).toBeGreaterThan(first.size);
  });

  it('reports a missing file as not existing, with zero counts', async () => {
    expect(await countLevelsAsync(path.join(dir, 'nope.log'), 'debug')).toMatchObject({
      exists: false,
      size: 0,
      counts: { fatal: 0, warning: 0, notice: 0, deprecated: 0, other: 0 },
    });
  });
});
