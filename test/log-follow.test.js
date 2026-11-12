import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readPage, PAGE_MAX_ENTRIES } from '../electron/services/logReader.cjs';
import logFollow from '../electron/services/logFollow.cjs';

// Fixtures copy the line shapes PHP and nginx really write; every path,
// message and date is invented. The poll timer is captured rather than real,
// so each `tick()` is one poll, deterministically.

let dir;
let timers;

function tick() {
  for (const t of [...timers.values()]) t();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-follow-'));
  timers = new Map();
  let next = 0;
  logFollow.__setDeps({
    setInterval: (fn) => {
      const id = ++next;
      timers.set(id, fn);
      return id;
    },
    clearInterval: (id) => timers.delete(id),
  });
});

afterEach(() => {
  logFollow.closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

const WARNING =
  '[12-Nov-2026 10:00:00 UTC] PHP Warning:  Undefined variable $acme in /srv/demo/wp-content/plugins/acme/acme.php on line 4\n';
const FATAL_WITH_TRACE =
  [
    '[12-Nov-2026 10:00:02 UTC] PHP Fatal error:  Uncaught Exception: Widget missing in /srv/demo/wp-content/plugins/acme/acme.php:12',
    'Stack trace:',
    '#0 /srv/demo/wp-includes/class-wp-hook.php(324): acme_boot()',
    '#1 {main}',
    '  thrown in /srv/demo/wp-content/plugins/acme/acme.php on line 12',
  ].join('\n') + '\n';
const NOTICE =
  '[12-Nov-2026 10:00:05 UTC] PHP Notice:  Function acme_old is deprecated in /srv/demo/wp-includes/functions.php on line 6078\n';

// Opens the view the way the renderer does: read the newest page, then
// follow from its newest entry.
function openView(file, kind = 'debug') {
  const page = readPage(file, kind);
  const events = [];
  const last = page.entries[page.entries.length - 1];
  logFollow.follow(
    'view-1',
    file,
    kind,
    { from: last ? last.offset : page.end, end: page.end },
    (e) => events.push(e)
  );
  return { page, events };
}

describe('logFollow: append', () => {
  it('pushes a fatal written after the view opened as one entry with its trace', () => {
    const file = path.join(dir, 'debug.log');
    fs.writeFileSync(file, WARNING);
    const { events } = openView(file);

    fs.appendFileSync(file, FATAL_WITH_TRACE);
    tick();

    expect(events).toHaveLength(1);
    const pushed = events[0].entries.filter((e) => e.offset >= WARNING.length);
    expect(pushed).toEqual([
      {
        offset: WARNING.length,
        time: '12-Nov-2026 10:00:02 UTC',
        level: 'fatal',
        text: FATAL_WITH_TRACE.slice('[12-Nov-2026 10:00:02 UTC] '.length, -1),
      },
    ]);
  });

  it('keeps a trace flushed after its header in the same entry', () => {
    const file = path.join(dir, 'debug.log');
    fs.writeFileSync(file, WARNING);
    const { events } = openView(file);
    const [header, ...trace] = FATAL_WITH_TRACE.split(/(?<=\n)/);

    fs.appendFileSync(file, header);
    tick();
    fs.appendFileSync(file, trace.join(''));
    tick();

    const last = events[events.length - 1].entries;
    expect(last.map((e) => e.offset)).toEqual([WARNING.length]);
    expect(last[0].text).toContain(
      'thrown in /srv/demo/wp-content/plugins/acme/acme.php'
    );
  });

  it('waits for a half-written line to finish', () => {
    const file = path.join(dir, 'debug.log');
    fs.writeFileSync(file, WARNING);
    const { events } = openView(file);

    fs.appendFileSync(file, NOTICE.slice(0, 40));
    tick();
    expect(events).toEqual([]);

    fs.appendFileSync(file, NOTICE.slice(40));
    tick();
    expect(events).toHaveLength(1);
    expect(events[0].entries.at(-1)).toMatchObject({
      offset: WARNING.length,
      level: 'notice',
      text: NOTICE.slice('[12-Nov-2026 10:00:05 UTC] '.length, -1),
    });
  });

  it('pushes nothing while the file is unchanged', () => {
    const file = path.join(dir, 'debug.log');
    fs.writeFileSync(file, WARNING);
    const { events } = openView(file);
    tick();
    tick();
    expect(events).toEqual([]);
  });
});

describe('logFollow: restarting from the new start', () => {
  it('after Clear (truncate in place) pushes an empty page, then follows the new start', () => {
    const file = path.join(dir, 'debug.log');
    fs.writeFileSync(file, WARNING + FATAL_WITH_TRACE);
    const { events } = openView(file);

    fs.truncateSync(file, 0);
    tick();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reset: true,
      page: { exists: true, size: 0, entries: [] },
    });

    fs.appendFileSync(file, NOTICE);
    tick();
    expect(events).toHaveLength(2);
    expect(events[1].entries).toMatchObject([{ offset: 0, level: 'notice' }]);
  });

  it('notices a truncation the writer has already grown past', () => {
    const file = path.join(dir, 'debug.log');
    fs.writeFileSync(file, WARNING);
    const { events } = openView(file);

    // Cleared, then more than the old size written before the next poll:
    // same file, bigger size, different bytes.
    fs.writeFileSync(file, FATAL_WITH_TRACE);
    tick();

    expect(events).toHaveLength(1);
    expect(events[0].reset).toBe(true);
    expect(events[0].page.entries).toMatchObject([{ offset: 0, level: 'fatal' }]);
  });

  it('after rotation (renamed away, new file created) restarts at the new file', () => {
    const file = path.join(dir, 'example.test.error.log');
    fs.writeFileSync(file, WARNING + WARNING);
    const { events } = openView(file);

    fs.renameSync(file, `${file}.0`);
    fs.writeFileSync(file, NOTICE + NOTICE + NOTICE);
    tick();

    expect(events).toHaveLength(1);
    expect(events[0].reset).toBe(true);
    expect(events[0].page.entries.map((e) => e.offset)).toEqual([
      0,
      NOTICE.length,
      NOTICE.length * 2,
    ]);

    // …and keeps following the new file, not the rotated one.
    fs.appendFileSync(`${file}.0`, FATAL_WITH_TRACE);
    fs.appendFileSync(file, WARNING);
    tick();
    expect(events).toHaveLength(2);
    expect(events[1].entries.at(-1)).toMatchObject({
      offset: NOTICE.length * 3,
      level: 'warning',
    });
  });

  it('picks a log up when it is created after the view opened', () => {
    const file = path.join(dir, 'debug.log');
    const { page, events } = openView(file);
    expect(page.exists).toBe(false);
    tick();
    expect(events).toEqual([]);

    fs.writeFileSync(file, FATAL_WITH_TRACE);
    tick();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reset: true, page: { exists: true } });
    expect(events[0].page.entries).toMatchObject([{ offset: 0, level: 'fatal' }]);
  });

  it('shows the missing state when the log is deleted', () => {
    const file = path.join(dir, 'debug.log');
    fs.writeFileSync(file, WARNING);
    const { events } = openView(file);

    fs.unlinkSync(file);
    tick();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reset: true,
      page: { exists: false, entries: [] },
    });
    tick();
    expect(events).toHaveLength(1);
  });

  it('restarts at the newest page when more than a page arrives between polls', () => {
    const file = path.join(dir, 'example.test.access.log');
    const line = (i) =>
      `127.0.0.1 - - [12/Nov/2026:10:00:00 +0000] "GET /?p=${i} HTTP/1.1" 200 512 "-" "curl/8.7.1"\n`;
    fs.writeFileSync(file, line(0));
    const { events } = openView(file, 'nginx-access');

    let burst = '';
    for (let i = 1; i <= PAGE_MAX_ENTRIES + 50; i++) burst += line(i);
    fs.appendFileSync(file, burst);
    tick();

    expect(events).toHaveLength(1);
    expect(events[0].reset).toBe(true);
    expect(events[0].page.entries).toHaveLength(PAGE_MAX_ENTRIES);
    expect(events[0].page.atStart).toBe(false);
    expect(events[0].page.entries.at(-1).text).toContain(`p=${PAGE_MAX_ENTRIES + 50} `);
  });
});

describe('logFollow: lifetime', () => {
  it('stops polling when the view unfollows', () => {
    const file = path.join(dir, 'debug.log');
    fs.writeFileSync(file, WARNING);
    const { events } = openView(file);
    expect(logFollow.activeCount()).toBe(1);

    logFollow.unfollow('view-1');
    expect(logFollow.activeCount()).toBe(0);
    expect(timers.size).toBe(0);

    fs.appendFileSync(file, NOTICE);
    tick();
    expect(events).toEqual([]);
  });

  it('closeAll releases every watch (window closed, app quitting)', () => {
    const file = path.join(dir, 'debug.log');
    fs.writeFileSync(file, WARNING);
    logFollow.follow('a', file, 'debug', { from: 0, end: WARNING.length }, () => {});
    logFollow.follow('b', file, 'debug', { from: 0, end: WARNING.length }, () => {});
    expect(timers.size).toBe(2);

    logFollow.closeAll();
    expect(logFollow.activeCount()).toBe(0);
    expect(timers.size).toBe(0);
  });

  it('following again under the same id replaces the old watch', () => {
    const file = path.join(dir, 'debug.log');
    fs.writeFileSync(file, WARNING);
    logFollow.follow('a', file, 'debug', { from: 0, end: WARNING.length }, () => {});
    logFollow.follow('a', file, 'debug', { from: 0, end: WARNING.length }, () => {});
    expect(logFollow.activeCount()).toBe(1);
    expect(timers.size).toBe(1);
  });
});
