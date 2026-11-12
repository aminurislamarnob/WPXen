import { describe, it, expect } from 'vitest';
import mkcert from '../electron/services/mkcert.cjs';

// userTrustArgs() is what ensureCA() hands to `security`. It must trust the
// root in the user domain: no `-d` (admin domain), which macOS refuses to
// change from an app without a terminal.

describe('userTrustArgs', () => {
  const args = mkcert.userTrustArgs(
    '/Users/me/Library/Application Support/mkcert',
    '/Users/me'
  );

  it('trusts the CA root in the login keychain', () => {
    expect(args).toEqual([
      'add-trusted-cert',
      '-r',
      'trustRoot',
      '-k',
      '/Users/me/Library/Keychains/login.keychain-db',
      '/Users/me/Library/Application Support/mkcert/rootCA.pem',
    ]);
  });

  it('never asks for the admin trust domain', () => {
    expect(args).not.toContain('-d');
  });
});

// certArgs() is what generateCert() hands to mkcert. Every Site certificate
// covers the domain and its wildcard, so `sub.shop.test` is trusted too
// (subdomain multisite), written to the same two files as before.
describe('certArgs', () => {
  const args = mkcert.certArgs(
    'shop.test',
    '/opt/homebrew/etc/nginx/certs/shop.test.pem',
    '/opt/homebrew/etc/nginx/certs/shop.test-key.pem'
  );

  it('mints one certificate for the domain and its wildcard', () => {
    expect(args).toEqual([
      '-cert-file',
      '/opt/homebrew/etc/nginx/certs/shop.test.pem',
      '-key-file',
      '/opt/homebrew/etc/nginx/certs/shop.test-key.pem',
      'shop.test',
      '*.shop.test',
    ]);
  });

  it('refuses a domain that could smuggle an argument', () => {
    expect(() => mkcert.certArgs('-install', '/c.pem', '/k.pem')).toThrow(/Unsafe/);
    expect(() => mkcert.certArgs('*.shop.test', '/c.pem', '/k.pem')).toThrow(/Unsafe/);
  });
});
