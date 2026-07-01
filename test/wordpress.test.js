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
