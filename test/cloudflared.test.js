import { describe, it, expect } from 'vitest';
import {
  tunnelNameForSite,
  parseTunnelCreateOutput,
  buildNamedRunArgs,
} from '../electron/services/cloudflared.cjs';

describe('tunnelNameForSite', () => {
  it('slugs the domain with a wpherd- prefix', () => {
    expect(tunnelNameForSite({ domain: 'demo.test' })).toBe('wpherd-demo-test');
  });

  it('collapses non-alphanumerics and trims edge dashes', () => {
    expect(tunnelNameForSite({ domain: 'My_Cool.Site.test' })).toBe(
      'wpherd-my-cool-site-test'
    );
  });

  it('caps the name at 63 chars', () => {
    const name = tunnelNameForSite({ domain: `${'a'.repeat(100)}.test` });
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.startsWith('wpherd-')).toBe(true);
  });
});

describe('parseTunnelCreateOutput', () => {
  it('extracts the UUID from tunnel create output', () => {
    const out =
      'Tunnel credentials written to /Users/dev/.cloudflared/6ff42ae2-765d-4adf-8112-31c55c1551ef.json.\n' +
      'Created tunnel wpherd-demo-test with id 6ff42ae2-765d-4adf-8112-31c55c1551ef';
    expect(parseTunnelCreateOutput(out)).toBe('6ff42ae2-765d-4adf-8112-31c55c1551ef');
  });

  it('lowercases the UUID', () => {
    expect(parseTunnelCreateOutput('id 6FF42AE2-765D-4ADF-8112-31C55C1551EF')).toBe(
      '6ff42ae2-765d-4adf-8112-31c55c1551ef'
    );
  });

  it('returns null when no UUID is present', () => {
    expect(parseTunnelCreateOutput('failed to create tunnel')).toBeNull();
    expect(parseTunnelCreateOutput('')).toBeNull();
    expect(parseTunnelCreateOutput(null)).toBeNull();
  });
});

describe('buildNamedRunArgs', () => {
  const ID = '6ff42ae2-765d-4adf-8112-31c55c1551ef';

  it('targets the http origin for plain sites', () => {
    expect(buildNamedRunArgs({ https: false }, ID)).toEqual([
      'tunnel',
      '--no-autoupdate',
      'run',
      '--url',
      'http://localhost:80',
      ID,
    ]);
  });

  it('targets 443 with TLS verification off for https sites', () => {
    expect(buildNamedRunArgs({ https: true }, ID)).toEqual([
      'tunnel',
      '--no-autoupdate',
      'run',
      '--url',
      'https://localhost:443',
      '--no-tls-verify',
      ID,
    ]);
  });
});
