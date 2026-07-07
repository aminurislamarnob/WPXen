import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import backups from '../electron/services/backups.cjs';
import scheduler from '../electron/services/scheduler.cjs';

// Minimal in-memory stand-in for JsonStore (flat keys are all these use).
function makeStore(initial = {}) {
  const data = { ...initial };
  return {
    get: (key, def) => (data[key] !== undefined ? data[key] : def),
    set: (key, value) => {
      data[key] = value;
    },
    data,
  };
}

const DAY = 24 * 60 * 60 * 1000;
const at = (msAgo, now = Date.now()) => new Date(now - msAgo).toISOString();

function meta(id, createdMsAgo, extra = {}) {
  return { id, siteId: 's1', createdAt: at(createdMsAgo), ...extra };
}

describe('selectBackupsToPrune', () => {
  it('keeps the newest N and prunes the rest', () => {
    const list = [meta('a', 0), meta('b', DAY), meta('c', 2 * DAY), meta('d', 3 * DAY)];
    expect(backups.selectBackupsToPrune(list, { retainCount: 2 })).toEqual(['c', 'd']);
  });

  it('prunes nothing when under the limit', () => {
    const list = [meta('a', 0), meta('b', DAY)];
    expect(backups.selectBackupsToPrune(list, { retainCount: 5 })).toEqual([]);
  });

  it('never prunes below one kept backup', () => {
    const list = [meta('a', 0), meta('b', DAY)];
    expect(backups.selectBackupsToPrune(list, { retainCount: 0 })).toEqual(['b']);
  });

  it('applies the age limit on top of the count', () => {
    const now = Date.now();
    const list = [meta('a', 0, {}), meta('b', 10 * DAY)];
    expect(
      backups.selectBackupsToPrune(list, { retainCount: 5, maxAgeDays: 7 }, now)
    ).toEqual(['b']);
  });

  it('is order-independent', () => {
    const list = [meta('c', 2 * DAY), meta('a', 0), meta('b', DAY)];
    expect(backups.selectBackupsToPrune(list, { retainCount: 1 })).toEqual(['b', 'c']);
  });
});

describe('backupFileName', () => {
  it('embeds a sortable local timestamp and the backup id', () => {
    const date = new Date(2026, 6, 7, 22, 30, 5); // Jul 7 2026, 22:30:05 local
    expect(backups.backupFileName('m4p2q8r1', date)).toBe(
      '2026-07-07_22-30-05--m4p2q8r1.zip'
    );
  });

  it('uses only Finder-safe characters', () => {
    expect(backups.backupFileName('abc123')).toMatch(
      /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}--abc123\.zip$/
    );
  });
});

describe('listBackups self-healing', () => {
  it('drops records whose archive is gone and keeps the rest, newest first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpherd-test-'));
    const live = path.join(dir, 'live.zip');
    fs.writeFileSync(live, 'x');
    const store = makeStore({
      backups: [
        { id: 'gone', siteId: 's1', createdAt: at(0), file: path.join(dir, 'gone.zip') },
        { id: 'old', siteId: 's1', createdAt: at(DAY), file: live },
        { id: 'other', siteId: 's2', createdAt: at(0), file: live },
      ],
    });
    const list = backups.listBackups(store, 's1');
    expect(list.map((b) => b.id)).toEqual(['old']);
    // Healed store keeps the other site's record.
    expect(
      store
        .get('backups')
        .map((b) => b.id)
        .sort()
    ).toEqual(['old', 'other']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('scheduler due-date math', () => {
  const now = Date.parse('2026-07-07T12:00:00Z');

  it('is never due when off or unknown', () => {
    expect(scheduler.isBackupDue('off', null, now)).toBe(false);
    expect(scheduler.isBackupDue(undefined, null, now)).toBe(false);
    expect(scheduler.isBackupDue('hourly', null, now)).toBe(false);
  });

  it('is due immediately when never backed up', () => {
    expect(scheduler.isBackupDue('daily', null, now)).toBe(true);
    expect(scheduler.isBackupDue('weekly', undefined, now)).toBe(true);
  });

  it('daily: due at >= 24h, not before', () => {
    expect(scheduler.isBackupDue('daily', at(23 * 3600e3, now), now)).toBe(false);
    expect(scheduler.isBackupDue('daily', at(24 * 3600e3, now), now)).toBe(true);
  });

  it('weekly: due at >= 7 days', () => {
    expect(scheduler.isBackupDue('weekly', at(6 * DAY, now), now)).toBe(false);
    expect(scheduler.isBackupDue('weekly', at(7 * DAY, now), now)).toBe(true);
  });

  it('treats an unparseable timestamp as due', () => {
    expect(scheduler.isBackupDue('daily', 'not-a-date', now)).toBe(true);
  });

  it('effectiveSchedule prefers the per-site override', () => {
    expect(scheduler.effectiveSchedule({ backupSchedule: 'weekly' }, 'daily')).toBe(
      'weekly'
    );
    expect(scheduler.effectiveSchedule({}, 'daily')).toBe('daily');
    expect(scheduler.effectiveSchedule({}, undefined)).toBe('off');
  });
});
