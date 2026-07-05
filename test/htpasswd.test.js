import { describe, it, expect } from 'vitest';
import {
  apr1Hash,
  htpasswdLine,
  isValidAuthUser,
  randomSalt,
} from '../electron/services/htpasswd.cjs';

describe('apr1Hash', () => {
  // Vectors generated with `openssl passwd -apr1 -salt <salt> <password>`.
  it.each([
    ['password', 'xxxxxxxx', '$apr1$xxxxxxxx$dxHfLAsjHkDRmG83UXe8K0'],
    ['s3cr3t!Pass', 'abcdefgh', '$apr1$abcdefgh$8vCK2R32TcsP87ax3PZJK/'],
  ])('matches the openssl vector for %s', (password, salt, expected) => {
    expect(apr1Hash(password, salt)).toBe(expected);
  });

  it('produces different hashes for different salts', () => {
    expect(apr1Hash('password', 'aaaaaaaa')).not.toBe(apr1Hash('password', 'bbbbbbbb'));
  });

  it('emits the $apr1$<salt>$<22 chars> format', () => {
    expect(apr1Hash('pw', 'salty')).toMatch(/^\$apr1\$salty\$[./0-9A-Za-z]{22}$/);
  });

  it('rejects an empty password', () => {
    expect(() => apr1Hash('', 'saltsalt')).toThrow();
  });

  it.each([['', 'toolongsalt99', 'bad$salt', 'white space']])(
    'rejects invalid salt %s',
    (salt) => {
      expect(() => apr1Hash('password', salt)).toThrow();
    }
  );
});

describe('randomSalt', () => {
  it('generates 8 chars from the crypt alphabet', () => {
    for (let i = 0; i < 20; i++) {
      expect(randomSalt()).toMatch(/^[./0-9A-Za-z]{8}$/);
    }
  });
});

describe('isValidAuthUser', () => {
  it.each([['guest'], ['client-2'], ['a.b_c'], ['A9']])('accepts %s', (user) => {
    expect(isValidAuthUser(user)).toBe(true);
  });

  it.each([
    [''],
    ['user:name'], // colon terminates the htpasswd user field
    ['line\nbreak'], // newline would inject a second entry
    ['spa ce'],
    ['x'.repeat(65)],
    [null],
    [42],
  ])('rejects %s', (user) => {
    expect(isValidAuthUser(user)).toBe(false);
  });
});

describe('htpasswdLine', () => {
  it('formats user:$apr1$salt$hash', () => {
    expect(htpasswdLine('guest', 'password', 'xxxxxxxx')).toBe(
      'guest:$apr1$xxxxxxxx$dxHfLAsjHkDRmG83UXe8K0'
    );
  });

  it('generates a salt when none is given', () => {
    expect(htpasswdLine('guest', 'pw')).toMatch(/^guest:\$apr1\$[./0-9A-Za-z]{8}\$/);
  });

  it('rejects a user containing a colon', () => {
    expect(() => htpasswdLine('user:name', 'pw')).toThrow();
  });
});
