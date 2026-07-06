import { describe, it, expect } from 'vitest';
import { generateSiteConfig } from '../electron/services/nginx.cjs';

const SITE = {
  name: 'Demo',
  domain: 'demo.test',
  path: '/Users/dev/Sites/demo',
  phpVersion: '8.3',
};

describe('generateSiteConfig share basic-auth', () => {
  it('merges aliases into server_name when no auth file is set', () => {
    const out = generateSiteConfig({ ...SITE, aliases: ['random.trycloudflare.com'] });
    expect(out).toContain('server_name demo.test random.trycloudflare.com;');
    expect(out).not.toContain('auth_basic');
  });

  it('is unchanged by shareAuthFile when there are no aliases', () => {
    const plain = generateSiteConfig(SITE);
    const withAuth = generateSiteConfig({
      ...SITE,
      shareAuthFile: '/etc/nginx/x.htpasswd',
    });
    expect(withAuth).toBe(plain);
  });

  it('splits aliases into an auth-protected server block', () => {
    const out = generateSiteConfig({
      ...SITE,
      aliases: ['random.trycloudflare.com'],
      shareAuthFile: '/opt/homebrew/etc/nginx/wpherd-htpasswd/demo.test.htpasswd',
    });
    // Local domain block stays password-free…
    expect(out).toContain('server_name demo.test;');
    // …the alias block carries the auth directives…
    expect(out).toContain('server_name random.trycloudflare.com;');
    expect(out).toContain('auth_basic "WPHerd Share";');
    expect(out).toContain(
      'auth_basic_user_file /opt/homebrew/etc/nginx/wpherd-htpasswd/demo.test.htpasswd;'
    );
    // …and auth appears only once (never on the primary block).
    expect(out.match(/auth_basic "/g)).toHaveLength(1);
  });

  it('protects the https alias block and keeps the redirect covering all hosts', () => {
    const out = generateSiteConfig({
      ...SITE,
      https: true,
      certPath: '/certs/demo.pem',
      keyPath: '/certs/demo-key.pem',
      aliases: ['random.trycloudflare.com'],
      shareAuthFile: '/opt/homebrew/etc/nginx/wpherd-htpasswd/demo.test.htpasswd',
    });
    // http→https redirect answers for every hostname.
    expect(out).toContain('server_name demo.test random.trycloudflare.com;');
    // Two TLS server blocks: plain local + auth-protected alias.
    expect(out.match(/listen 443 ssl;/g)).toHaveLength(2);
    expect(out.match(/auth_basic "/g)).toHaveLength(1);
  });

  it('rejects an unsafe htpasswd path', () => {
    expect(() =>
      generateSiteConfig({
        ...SITE,
        aliases: ['a.trycloudflare.com'],
        shareAuthFile: '/tmp/x;}\ninjected',
      })
    ).toThrow(/htpasswd/i);
  });
});
