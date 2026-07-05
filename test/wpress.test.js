import { describe, it, expect } from 'vitest';
import wpress from '../electron/services/wpress.cjs';

const { HEADER_SIZE } = wpress;

// Builds a syntactically valid .wpress header block.
function makeHeader({ name = 'file.php', size = '123', mtime = '1700000000', dir = 'plugins/demo' } = {}) {
  const buf = Buffer.alloc(HEADER_SIZE);
  buf.write(name, 0, 'utf8');
  buf.write(String(size), 255, 'utf8');
  buf.write(String(mtime), 269, 'utf8');
  buf.write(dir, 281, 'utf8');
  return buf;
}

describe('parseWpressHeader', () => {
  it('parses a normal header', () => {
    const h = wpress.parseWpressHeader(makeHeader());
    expect(h).toEqual({ name: 'file.php', size: 123, mtime: 1700000000, dir: 'plugins/demo' });
  });

  it('returns null for the EOF block (all NULs)', () => {
    expect(wpress.parseWpressHeader(Buffer.alloc(HEADER_SIZE))).toBeNull();
  });

  it('throws on a truncated buffer', () => {
    expect(() => wpress.parseWpressHeader(Buffer.alloc(100))).toThrow(/could not be parsed/);
  });

  it('throws on a non-numeric size', () => {
    expect(() => wpress.parseWpressHeader(makeHeader({ size: 'abc' }))).toThrow(
      /could not be parsed/
    );
  });

  it('throws on a negative size', () => {
    expect(() => wpress.parseWpressHeader(makeHeader({ size: '-5' }))).toThrow(
      /could not be parsed/
    );
  });

  it('throws on an empty filename', () => {
    expect(() => wpress.parseWpressHeader(makeHeader({ name: '' }))).toThrow(
      /could not be parsed/
    );
  });

  it('handles a root-level entry (dir ".")', () => {
    const h = wpress.parseWpressHeader(makeHeader({ name: 'database.sql', dir: '.' }));
    expect(h.name).toBe('database.sql');
    expect(h.dir).toBe('.');
  });
});

describe('sanitizeWpressPath', () => {
  it('joins dir and name', () => {
    expect(wpress.sanitizeWpressPath('plugins/demo', 'x.php')).toBe('plugins/demo/x.php');
  });

  it('treats "." dir as root', () => {
    expect(wpress.sanitizeWpressPath('.', 'database.sql')).toBe('database.sql');
  });

  it('normalizes redundant segments', () => {
    expect(wpress.sanitizeWpressPath('./plugins', 'a.php')).toBe('plugins/a.php');
  });

  it.each([
    ['..', 'evil.php'],
    ['plugins/../../..', 'x.php'],
    ['plugins', '../../evil.php'],
  ])('rejects traversal dir=%j name=%j', (dir, name) => {
    expect(() => wpress.sanitizeWpressPath(dir, name)).toThrow(/traversal/);
  });

  it('rejects absolute paths', () => {
    expect(() => wpress.sanitizeWpressPath('/etc', 'passwd')).toThrow(/absolute/);
  });

  it('rejects NUL and newline characters', () => {
    expect(() => wpress.sanitizeWpressPath('plugins', 'a\0b.php')).toThrow(/unsafe/);
    expect(() => wpress.sanitizeWpressPath('plu\ngins', 'a.php')).toThrow(/unsafe/);
  });
});

describe('replaceServmaskPrefix', () => {
  it('replaces the token with the target prefix', () => {
    expect(
      wpress.replaceServmaskPrefix('CREATE TABLE `SERVMASK_PREFIX_options` (', 'wp_')
    ).toBe('CREATE TABLE `wp_options` (');
  });

  it('replaces multiple occurrences on one line', () => {
    expect(
      wpress.replaceServmaskPrefix('SERVMASK_PREFIX_a JOIN SERVMASK_PREFIX_b', 'wp_')
    ).toBe('wp_a JOIN wp_b');
  });

  it('leaves lines without the token untouched', () => {
    const line = "INSERT INTO `wp_posts` VALUES (1, 'hello');";
    expect(wpress.replaceServmaskPrefix(line, 'wp_')).toBe(line);
  });
});
