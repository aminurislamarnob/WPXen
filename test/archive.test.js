import { describe, it, expect } from 'vitest';
import archive from '../electron/services/archive.cjs';

describe('assertSafeEntries', () => {
  it('accepts normal relative entries', () => {
    expect(
      archive.assertSafeEntries([
        'wpxen-manifest.json',
        'database.sql',
        'files/wp-content/plugins/x/x.php',
        'files/wp-config.php',
      ])
    ).toBe(true);
  });

  it.each([['../evil.php'], ['files/../../evil.php'], ['a/../../b'], ['..']])(
    'rejects traversal entry %j',
    (entry) => {
      expect(() => archive.assertSafeEntries([entry])).toThrow(/traversal/);
    }
  );

  it.each([['/etc/passwd'], ['/tmp/x'], ['C:/Windows/evil'], ['C:\\evil']])(
    'rejects absolute entry %j',
    (entry) => {
      expect(() => archive.assertSafeEntries([entry])).toThrow(/absolute/);
    }
  );

  it('rejects entries with NUL or newline', () => {
    expect(() => archive.assertSafeEntries(['a\0b'])).toThrow(/unsafe/);
    expect(() => archive.assertSafeEntries(['a\nb'])).toThrow(/unsafe/);
  });

  it('rejects empty and non-string entries', () => {
    expect(() => archive.assertSafeEntries([''])).toThrow(/invalid/);
    expect(() => archive.assertSafeEntries([null])).toThrow(/invalid/);
  });

  it('rejects backslash traversal', () => {
    expect(() => archive.assertSafeEntries(['a\\..\\evil'])).toThrow(/traversal/);
  });
});
