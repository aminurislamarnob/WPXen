import { describe, it, expect } from 'vitest';
import oauth from '../electron/services/cloud/oauth.cjs';
import dropbox from '../electron/services/cloud/dropbox.cjs';
import providers from '../electron/services/cloud/providers.cjs';

describe('PKCE', () => {
  it('generates verifiers in the RFC 7636 length/charset range', () => {
    const v = oauth.generateVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(oauth.generateVerifier()).not.toBe(v);
  });

  it('derives the S256 challenge from the RFC 7636 appendix vector', () => {
    expect(
      oauth.challengeFromVerifier('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')
    ).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('Dropbox chunk planning', () => {
  const MB = 1024 * 1024;

  it('covers the file exactly with sequential offsets', () => {
    const size = 20 * MB + 123;
    const chunks = dropbox.planChunks(size, 8 * MB);
    expect(chunks.map((c) => c.offset)).toEqual([0, 8 * MB, 16 * MB]);
    expect(chunks.map((c) => c.length)).toEqual([8 * MB, 8 * MB, 4 * MB + 123]);
    expect(chunks.at(-1).last).toBe(true);
    expect(chunks.slice(0, -1).every((c) => !c.last)).toBe(true);
    expect(chunks.reduce((sum, c) => sum + c.length, 0)).toBe(size);
  });

  it('handles an exact multiple without a trailing empty chunk', () => {
    const chunks = dropbox.planChunks(16 * MB, 8 * MB);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toEqual({ offset: 8 * MB, length: 8 * MB, last: true });
  });

  it('handles small and empty files', () => {
    expect(dropbox.planChunks(10, 8 * MB)).toEqual([
      { offset: 0, length: 10, last: true },
    ]);
    expect(dropbox.planChunks(0)).toEqual([{ offset: 0, length: 0, last: true }]);
  });
});

describe('remote archive naming', () => {
  const site = { domain: 'my-blog.test' };

  it('round-trips the backup id through the remote name', () => {
    const backup = { id: 'abc123xyz', createdAt: new Date(2026, 6, 7, 22, 30, 5).toISOString() };
    const name = providers.remoteNameFor(site, backup);
    expect(name).toBe('my-blog.test--2026-07-07_22-30-05--abc123xyz.zip');
    expect(providers.parseRemoteBackupId(name, site)).toBe('abc123xyz');
  });

  it('still parses legacy names without a timestamp', () => {
    expect(providers.parseRemoteBackupId('my-blog.test--abc123xyz.zip', site)).toBe(
      'abc123xyz'
    );
  });

  it('rejects names for another site or malformed names', () => {
    expect(providers.parseRemoteBackupId('other.test--abc.zip', site)).toBe(null);
    expect(providers.parseRemoteBackupId('random.zip', site)).toBe(null);
    expect(providers.parseRemoteBackupId('my-blog.test--bad id!.zip', site)).toBe(null);
  });

  it('sitePrefix matches only this site', () => {
    expect('my-blog.test--a.zip'.startsWith(providers.sitePrefix(site))).toBe(true);
    expect('my-blog.test2--a.zip'.startsWith(providers.sitePrefix(site))).toBe(false);
  });
});
