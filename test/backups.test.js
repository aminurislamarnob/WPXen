import { describe, it, expect } from 'vitest';
import {
  formatTimestamp,
  parseBackupDirName,
  buildTarCreateArgs,
  buildTarExtractArgs,
  buildManifest,
  isPathInside,
  isSafeSiteId,
} from '../electron/services/backups.cjs';
import { buildDumpArgs } from '../electron/services/mysql.cjs';

describe('formatTimestamp', () => {
  it('formats YYYY-MM-DD-HHmmss in local time', () => {
    expect(formatTimestamp(new Date(2026, 6, 5, 14, 25, 30))).toBe('2026-07-05-142530');
  });

  it('zero-pads every component', () => {
    expect(formatTimestamp(new Date(2026, 0, 1, 2, 3, 4))).toBe('2026-01-01-020304');
  });
});

describe('parseBackupDirName', () => {
  it('accepts a formatTimestamp value', () => {
    const ts = formatTimestamp();
    expect(parseBackupDirName(ts)).toBe(ts);
  });

  it.each([['..'], ['../../etc'], ['2026-07-05'], ['x2026-07-05-142530'], [''], [null]])(
    'rejects %s',
    (name) => {
      expect(parseBackupDirName(name)).toBeNull();
    }
  );
});

describe('tar argv builders', () => {
  it('creates a gzipped archive of the site dir contents', () => {
    expect(buildTarCreateArgs('/Users/dev/Sites/demo', '/backups/files.tar.gz')).toEqual([
      '-czf',
      '/backups/files.tar.gz',
      '-C',
      '/Users/dev/Sites/demo',
      '.',
    ]);
  });

  it('extracts into the destination dir', () => {
    expect(buildTarExtractArgs('/backups/files.tar.gz', '/Users/dev/Sites/demo')).toEqual(
      ['-xzf', '/backups/files.tar.gz', '-C', '/Users/dev/Sites/demo']
    );
  });
});

describe('buildManifest', () => {
  const site = {
    id: 'abc123',
    name: 'Demo',
    domain: 'demo.test',
    url: 'http://demo.test',
    dbName: 'demo_test',
  };

  it('captures the site identity and artifact sizes', () => {
    const m = buildManifest(site, {
      wpVersion: '6.8',
      phpVersion: '8.3',
      filesBytes: 123,
      dbBytes: 45,
    });
    expect(m).toMatchObject({
      version: 1,
      siteId: 'abc123',
      siteName: 'Demo',
      domain: 'demo.test',
      url: 'http://demo.test',
      dbName: 'demo_test',
      wpVersion: '6.8',
      phpVersion: '8.3',
      filesBytes: 123,
      dbBytes: 45,
    });
    expect(new Date(m.createdAt).toString()).not.toBe('Invalid Date');
  });

  it('nulls unknown fields rather than dropping them', () => {
    const m = buildManifest(site);
    expect(m.wpVersion).toBeNull();
    expect(m.filesBytes).toBeNull();
  });
});

describe('isPathInside', () => {
  it('accepts children and rejects escapes', () => {
    expect(isPathInside('/backups', '/backups/site/ts')).toBe(true);
    expect(isPathInside('/backups', '/backups')).toBe(false);
    expect(isPathInside('/backups', '/backups/../etc')).toBe(false);
    expect(isPathInside('/backups', '/etc/passwd')).toBe(false);
  });
});

describe('isSafeSiteId', () => {
  it('accepts generateId-style base36 ids', () => {
    expect(isSafeSiteId('m3k9x0abc12')).toBe(true);
  });

  it.each([[''], ['../x'], ['a/b'], ['id with space'], [null]])('rejects %s', (id) => {
    expect(isSafeSiteId(id)).toBe(false);
  });
});

describe('mysql buildDumpArgs', () => {
  it('builds a consistent single-transaction dump argv', () => {
    expect(buildDumpArgs('demo_db', { user: 'root', password: '' })).toEqual([
      '-u',
      'root',
      '--single-transaction',
      '--routines',
      '--triggers',
      'demo_db',
    ]);
  });

  it('appends the password to the -p token', () => {
    expect(buildDumpArgs('demo_db', { user: 'root', password: 's3cret' })).toEqual([
      '-u',
      'root',
      '-ps3cret',
      '--single-transaction',
      '--routines',
      '--triggers',
      'demo_db',
    ]);
  });
});
