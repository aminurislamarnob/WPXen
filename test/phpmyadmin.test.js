import { describe, it, expect } from 'vitest';
import phpmyadmin from '../electron/services/phpmyadmin.cjs';
import { DB_NAME_RE } from '../electron/services/validation.cjs';

// getUrl() builds the deep link an in-app browser tab (or the system browser)
// is pointed at. The db name reaching it has already been gated by
// DB_NAME_RE in ipc.cjs — both halves are covered here.

describe('getUrl', () => {
  it('returns the bare host with no database', () => {
    expect(phpmyadmin.getUrl()).toBe('http://phpmyadmin.test/');
    expect(phpmyadmin.getUrl(null)).toBe('http://phpmyadmin.test/');
    expect(phpmyadmin.getUrl('')).toBe('http://phpmyadmin.test/');
  });

  it('deep-links straight to a site database', () => {
    expect(phpmyadmin.getUrl('wpdevpilot_blog')).toBe(
      'http://phpmyadmin.test/index.php?route=/database/structure&db=wpdevpilot_blog'
    );
  });

  it('encodes the database name', () => {
    // Unreachable through the IPC handler, but getUrl must not be the weak
    // link if it ever gains another caller.
    expect(phpmyadmin.getUrl('a b&c')).toContain('db=a%20b%26c');
  });
});

describe('DB_NAME_RE (the gate in front of getUrl)', () => {
  it('accepts the names WPDevPilot generates', () => {
    for (const name of ['wp_site', 'wpdevpilot_blog1', 'A_b_9', 'x'.repeat(64)]) {
      expect(DB_NAME_RE.test(name)).toBe(true);
    }
  });

  it('rejects anything that could steer the URL or a SQL identifier', () => {
    for (const name of [
      'foo;drop',
      '../etc',
      'foo bar',
      'foo&db=other',
      'foo/bar',
      "foo'",
      'foo`',
      '',
      'x'.repeat(65),
    ]) {
      expect(DB_NAME_RE.test(name)).toBe(false);
    }
  });
});
