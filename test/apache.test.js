import { describe, it, expect } from 'vitest';
import apache from '../electron/services/apache.cjs';
import nginx from '../electron/services/nginx.cjs';

const baseSite = {
  name: 'Demo',
  domain: 'demo.test',
  path: '/Users/x/Sites/demo',
  phpVersion: '8.3',
  webserver: 'apache',
};

describe('generateApacheVhost', () => {
  it('emits a loopback vhost with WP fallback and fcgi handler', () => {
    const vhost = apache.generateApacheVhost(baseSite);
    expect(vhost).toContain(`<VirtualHost 127.0.0.1:${apache.APACHE_HTTP_PORT}>`);
    expect(vhost).toContain('ServerName demo.test');
    expect(vhost).toContain('DocumentRoot "/Users/x/Sites/demo"');
    expect(vhost).toContain('FallbackResource /index.php');
    expect(vhost).toMatch(/SetHandler "proxy:fcgi:\/\/127\.0\.0\.1:9000"/);
    expect(vhost).toContain('Require all granted');
  });

  it('restores HTTPS from the forwarded proto for is_ssl()', () => {
    const vhost = apache.generateApacheVhost(baseSite);
    expect(vhost).toContain('SetEnvIf X-Forwarded-Proto https HTTPS=on');
  });

  it('sizes LimitRequestBody from a per-site upload override', () => {
    const vhost = apache.generateApacheVhost({
      ...baseSite,
      phpSettings: { upload_max_filesize: 200 },
    });
    // 200MB upload + multipart headroom (matches nginx's client_max_body_size)
    const expectedBytes = Math.max(8, Math.ceil(200 * 1.1)) * 1024 * 1024;
    expect(vhost).toContain(`LimitRequestBody ${expectedBytes}`);
  });

  it('adds ServerAlias for aliases', () => {
    const vhost = apache.generateApacheVhost({
      ...baseSite,
      aliases: ['www.demo.test'],
    });
    expect(vhost).toContain('ServerAlias www.demo.test');
  });

  it('rejects an unsafe domain', () => {
    expect(() =>
      apache.generateApacheVhost({ ...baseSite, domain: 'demo.test;rm -rf' })
    ).toThrow(/Unsafe domain/);
  });

  it('rejects an unsafe document root path', () => {
    expect(() =>
      apache.generateApacheVhost({ ...baseSite, path: '/Sites/demo"\nEvil' })
    ).toThrow(/Unsafe site path/);
  });
});

describe('generateHttpdConf', () => {
  it('listens only on loopback and includes the wpherd servers dir', () => {
    const conf = apache.generateHttpdConf('/opt/homebrew');
    expect(conf).toContain(`Listen 127.0.0.1:${apache.APACHE_HTTP_PORT}`);
    expect(conf).toContain('ServerRoot "/opt/homebrew"');
    expect(conf).toMatch(/IncludeOptional ".*wpherd-servers\/\*\.conf"/);
    expect(conf).toContain('Require all denied'); // default deny
  });
});

describe('loadModuleLines', () => {
  it('emits proxy_fcgi + rewrite when the modules dir is unknown', () => {
    const lines = apache.loadModuleLines(null);
    expect(lines).toContain('LoadModule proxy_fcgi_module lib/httpd/modules/mod_proxy_fcgi.so');
    expect(lines).toContain('LoadModule rewrite_module lib/httpd/modules/mod_rewrite.so');
  });
});

describe('nginx proxy mode for Apache-flagged sites', () => {
  it('proxies to the Apache port instead of using fastcgi', () => {
    const conf = nginx.generateSiteConfig(baseSite);
    expect(conf).toContain(`proxy_pass http://127.0.0.1:${apache.APACHE_HTTP_PORT}`);
    expect(conf).toContain('proxy_set_header X-Forwarded-Proto $scheme;');
    expect(conf).not.toContain('fastcgi_pass');
  });

  it('keeps the TLS server block and http->https redirect for https apache sites', () => {
    const conf = nginx.generateSiteConfig({
      ...baseSite,
      https: true,
      certPath: '/certs/demo.pem',
      keyPath: '/certs/demo-key.pem',
    });
    expect(conf).toContain('listen 443 ssl;');
    expect(conf).toContain('return 301 https://$host$request_uri;');
    expect(conf).toContain(`proxy_pass http://127.0.0.1:${apache.APACHE_HTTP_PORT}`);
  });

  it('still uses fastcgi for nginx (default) sites', () => {
    const conf = nginx.generateSiteConfig({ ...baseSite, webserver: 'nginx' });
    expect(conf).toContain('fastcgi_pass');
    expect(conf).not.toContain('proxy_pass http://127.0.0.1:8080');
  });
});
