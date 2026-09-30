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
