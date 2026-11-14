import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  readPage,
  searchLog,
  searchLogAsync,
  SEARCH_MAX_MATCHES,
  PAGE_MAX_ENTRIES,
} from '../electron/services/logReader.cjs';

// Fixtures copy the line shapes PHP and nginx really write; every path,
// message and date is invented.

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-log-search-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(name, text) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text);
  return p;
}

const deprecation = (i) =>
  `[12-Nov-2026 10:00:00 UTC] PHP Deprecated:  Function legacy_${i}() is deprecated in /srv/demo/y.php on line ${i}`;

// The fatal a user is hunting for, with its trace, followed by `after`
// deprecation notices — enough to push it far behind the newest page.
function buriedFatal(after) {
  const fatal = [
    '[01-Nov-2026 08:15:00 UTC] PHP Fatal error:  Uncaught Error: Class "Acme_Widget" not found in /srv/demo/wp-content/plugins/acme/acme.php:40',
    'Stack trace:',
    '#0 /srv/demo/wp-includes/class-wp-hook.php(324): acme_boot()',
    '#1 {main}',
    '  thrown in /srv/demo/wp-content/plugins/acme/acme.php on line 40',
  ].join('\n');
  const lines = [fatal];
  for (let i = 0; i < after; i++) lines.push(deprecation(i));
  return { text: lines.join('\n') + '\n', fatal };
}

describe('searchLog', () => {
  it('finds a whole entry, trace intact, far beyond the newest page and the old 256 KB tail', () => {
    const { text, fatal } = buriedFatal(20_000); // ~2.4 MB of notices after it
    const p = fixture('debug.log', text);
    expect(fs.statSync(p).size).toBeGreaterThan(2 * 1024 * 1024);
    expect(readPage(p, 'debug').entries.some((e) => e.text.includes('Acme_Widget'))).toBe(
      false
    );

    const result = searchLog(p, 'debug', { query: 'Acme_Widget' });

    expect(result.exists).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      offset: 0,
      time: '01-Nov-2026 08:15:00 UTC',
      level: 'fatal',
      text: fatal.replace('[01-Nov-2026 08:15:00 UTC] ', ''),
    });
    expect(result.atStart).toBe(true);
  });

  it('matches case-insensitively, in the message and the timestamp', () => {
    const p = fixture('debug.log', buriedFatal(10).text);
    expect(searchLog(p, 'debug', { query: 'acme_WIDGET' }).entries).toHaveLength(1);
    expect(searchLog(p, 'debug', { query: 'fatal ERROR' }).entries).toHaveLength(1);
    expect(searchLog(p, 'debug', { query: '01-nov-2026' }).entries).toHaveLength(1);
    expect(searchLog(p, 'debug', { query: 'no such thing' }).entries).toEqual([]);
  });

  it('caps a common term and continues from its cursor without duplicates or gaps', () => {
    const count = SEARCH_MAX_MATCHES * 4 + 37;
    const lines = [];
    for (let i = 0; i < count; i++) {
      lines.push(deprecation(i));
      if (i % 3 === 0) lines.push(`[12-Nov-2026 10:00:00 UTC] acme: unrelated line ${i}`);
    }
    const p = fixture('debug.log', lines.join('\n') + '\n');

    const first = searchLog(p, 'debug', { query: 'is DEPRECATED' });
    expect(first.entries).toHaveLength(SEARCH_MAX_MATCHES);
    expect(first.atStart).toBe(false);
    // Newest matches first: the batch ends with the file's last notice.
    expect(first.entries.at(-1).text).toContain(`legacy_${count - 1}()`);

    const batches = [first];
    while (!batches.at(-1).atStart) {
      batches.push(
        searchLog(p, 'debug', { query: 'is deprecated', end: batches.at(-1).pageStart })
      );
      if (batches.length > 100) throw new Error('search never reached the start');
    }
    expect(batches.length).toBe(5);

    const all = batches.reverse().flatMap((b) => b.entries);
    expect(all.map((e) => /legacy_(\d+)\(/.exec(e.text)[1])).toEqual(
      Array.from({ length: count }, (_, i) => String(i))
    );
    expect(new Set(all.map((e) => e.offset)).size).toBe(count);
  });

  it('searches the nginx access log, beyond its newest page', () => {
    const lines = [];
    for (let i = 0; i < PAGE_MAX_ENTRIES * 3; i++) {
      const req = i === 7 ? 'POST /wp-json/acme/v1/import' : `GET /page-${i}/`;
      lines.push(
        `127.0.0.1 - - [12/Nov/2026:10:00:00 +0000] "${req} HTTP/1.1" 200 512 "-" "Mozilla/5.0 (Macintosh)"`
      );
    }
    const p = fixture('demo.test.access.log', lines.join('\n') + '\n');

    const result = searchLog(p, 'nginx-access', { query: 'post /WP-JSON/acme' });

    expect(result.entries).toEqual([
      {
        offset: (lines[0].length + 1) * 7,
        time: '12/Nov/2026:10:00:00 +0000',
        level: null,
        text: lines[7],
      },
    ]);
    expect(result.atStart).toBe(true);
  });

  it('respects a level filter on the error logs, and ignores it on the access log', () => {
    const { text } = buriedFatal(50);
    const p = fixture('debug.log', text);
    const hits = (levels) =>
      searchLog(p, 'debug', { query: 'srv/demo', levels }).entries.map((e) => e.level);

    expect(hits(['fatal'])).toEqual(['fatal']);
    expect(hits(['fatal', 'warning', 'notice', 'other'])).toEqual(['fatal']);
    expect(hits(['deprecated'])).toHaveLength(50);
    expect(hits(undefined)).toHaveLength(51);

    const access = fixture(
      'demo.test.access.log',
      '127.0.0.1 - - [12/Nov/2026:10:00:00 +0000] "GET /srv/demo HTTP/1.1" 404 0 "-" "curl/8.7.1"\n'
    );
    expect(
      searchLog(access, 'nginx-access', { query: 'srv/demo', levels: ['fatal'] }).entries
    ).toHaveLength(1);
  });

  it('reports a missing file as not existing, and refuses an empty term', () => {
    expect(searchLog(path.join(dir, 'nope.log'), 'debug', { query: 'x' })).toMatchObject({
      exists: false,
      entries: [],
      atStart: true,
    });
    const p = fixture('debug.log', buriedFatal(1).text);
    expect(() => searchLog(p, 'debug', { query: '   ' })).toThrow(/empty/);
    expect(() => searchLog(p, 'syslog', { query: 'x' })).toThrow(/Unknown log type/);
  });
});

// Story 54: a search that matches nothing reads the whole file; on the main
// process it must give the event loop a turn while it does.
describe('searchLogAsync', () => {
  it('returns exactly what searchLog returns, batch after batch, however finely it is sliced', async () => {
    const { text } = buriedFatal(3000);
    const p = fixture('debug.log', text + buriedFatal(2000).text);
    let end;
    for (let i = 0; i < 50; i++) {
      const opts = { query: 'acme', end };
      const sliced = await searchLogAsync(p, 'debug', { ...opts, sliceMs: 0 });
      expect(sliced).toEqual(searchLog(p, 'debug', opts));
      if (sliced.atStart) return;
      end = sliced.pageStart;
    }
    throw new Error('search never reached the start of the file');
  });

  it('rejects the same bad input searchLog throws on', async () => {
    const p = fixture('debug.log', deprecation(1) + '\n');
    await expect(searchLogAsync(p, 'debug', { query: '   ' })).rejects.toThrow(/empty/);
  });

  it('keeps the event loop turning while a term with no match reads a large file', async () => {
    const p = path.join(dir, 'debug.log');
    const block = Buffer.from(
      Array.from({ length: 4096 }, (_, i) => deprecation(i) + '\n').join('')
    );
    const fd = fs.openSync(p, 'w');
    for (let written = 0; written < 48 * 1024 * 1024; written += block.length) {
      fs.writeSync(fd, block);
    }
    fs.closeSync(fd);

    let last = performance.now();
    let worst = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 2);
    try {
      const result = await searchLogAsync(p, 'debug', { query: 'no such thing' });
      worst = Math.max(worst, performance.now() - last);
      expect(result).toMatchObject({ entries: [], atStart: true });
    } finally {
      clearInterval(timer);
    }
    expect(worst).toBeLessThan(100);
  });
});

describe('searchLog: large files', () => {
  function bigLog() {
    const p = path.join(dir, 'debug.log');
    const block = Buffer.from(
      Array.from({ length: 4096 }, (_, i) => deprecation(i) + '\n').join('')
    );
    const fd = fs.openSync(p, 'w');
    for (let written = 0; written < 200 * 1024 * 1024; written += block.length) {
      fs.writeSync(fd, block);
    }
    fs.closeSync(fd);
    return p;
  }

  it('returns a capped first batch of a term with millions of matches in under a second', () => {
    const p = bigLog();
    const started = performance.now();
    const result = searchLog(p, 'debug', { query: 'DEPRECATED' });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result.entries).toHaveLength(SEARCH_MAX_MATCHES);
    expect(result.atStart).toBe(false);
  });
});
