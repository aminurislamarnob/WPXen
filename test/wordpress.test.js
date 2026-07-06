import { describe, it, expect } from 'vitest';
import wordpress from '../electron/services/wordpress.cjs';

describe('sanitizeDomain', () => {
  it('lowercases and strips shell metacharacters', () => {
    expect(wordpress.sanitizeDomain('Foo`Bar!.test')).toBe('foo-bar-test');
  });

  it('collapses and trims separators', () => {
    expect(wordpress.sanitizeDomain('  My  Site  ')).toBe('my-site');
  });
});

describe('sanitizeDbName', () => {
  it('replaces unsafe characters with underscores', () => {
    expect(wordpress.sanitizeDbName('a-b;c')).toBe('a_b_c');
  });

  it('produces a valid MySQL identifier', () => {
    expect(wordpress.sanitizeDbName('My Blog!')).toMatch(/^[a-z0-9_]+$/);
  });
});

describe('generateId', () => {
  it('produces unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => wordpress.generateId()));
    expect(ids.size).toBe(1000);
  });
});

describe('selectExistingPlugins', () => {
  const present = new Set([
    'woocommerce/woocommerce.php',
    'akismet/akismet.php',
    'hello.php',
  ]);
  const exists = (p) => present.has(p);

  it('keeps only plugins whose file exists', () => {
    const input = ['woocommerce/woocommerce.php', 'missing/missing.php', 'hello.php'];
    expect(wordpress.selectExistingPlugins(input, exists)).toEqual([
      'woocommerce/woocommerce.php',
      'hello.php',
    ]);
  });

  it('de-duplicates and ignores non-string entries', () => {
    const input = ['hello.php', 'hello.php', null, 42, ''];
    expect(wordpress.selectExistingPlugins(input, exists)).toEqual(['hello.php']);
  });

  it('returns [] for non-array input', () => {
    expect(wordpress.selectExistingPlugins(undefined, exists)).toEqual([]);
    expect(wordpress.selectExistingPlugins(null, exists)).toEqual([]);
  });
});
