import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import herd from '../electron/services/herd.cjs';

// A fake Herd install in a temp dir, laid out the way Herd 2 writes it:
// config/valet/{config.json,Sites,Certificates,Nginx} and bin/php → php83.

let tmp;
let root;
let parked;

function wpSite(dir, config) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'wp-settings.php'), '<?php');
  fs.writeFileSync(path.join(dir, 'wp-config.php'), config);
}

const wpConfig = ({ db = 'shop', host = 'localhost', extra = '' } = {}) => `<?php
define( 'DB_NAME', '${db}' );
define( 'DB_USER', 'root' );
define( "DB_HOST", "${host}" );
$table_prefix = 'wpx_';
${extra}
require_once ABSPATH . 'wp-settings.php';
`;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-herd-'));
  root = path.join(tmp, 'Herd-support');
  parked = path.join(tmp, 'Herd');
  const valet = path.join(root, 'config', 'valet');
  for (const d of ['Sites', 'Certificates', 'Nginx']) {
    fs.mkdirSync(path.join(valet, d), { recursive: true });
  }
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'php83'), '');
  fs.symlinkSync(path.join(root, 'bin', 'php83'), path.join(root, 'bin', 'php'));
  fs.writeFileSync(
    path.join(valet, 'config.json'),
    JSON.stringify({ tld: 'test', paths: [path.join(valet, 'Sites'), `${parked}/`] })
  );

  wpSite(path.join(parked, 'Shop'), wpConfig());
  fs.writeFileSync(path.join(valet, 'Certificates', 'shop.test.crt'), '');
  fs.writeFileSync(
    path.join(valet, 'Nginx', 'shop.test'),
    'location ~ \\.php$ {\n  fastcgi_pass $herd_sock_84;\n}\n'
  );
  fs.mkdirSync(path.join(parked, 'laravel-app'), { recursive: true }); // not WP
  fs.mkdirSync(path.join(parked, '.hidden'), { recursive: true });

  // A linked site whose name also exists as a parked folder: the link wins.
  wpSite(path.join(tmp, 'elsewhere', 'blog'), wpConfig({ db: 'blog_linked' }));
  wpSite(path.join(parked, 'blog'), wpConfig({ db: 'blog_parked' }));
  fs.symlinkSync(path.join(tmp, 'elsewhere', 'blog'), path.join(valet, 'Sites', 'blog'));
  fs.symlinkSync(path.join(tmp, 'gone'), path.join(valet, 'Sites', 'dangling'));
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('reading Herd', () => {
  it('detects the install and its global PHP', () => {
    expect(herd.isInstalled(root)).toBe(true);
    expect(herd.isInstalled(path.join(tmp, 'nope'))).toBe(false);
    expect(herd.globalPhpVersion(root)).toBe('8.3');
  });

  it('lists parked and linked sites, links first, skipping dangling and dot folders', () => {
    const sites = herd.listServedSites(root);
    const byDomain = Object.fromEntries(sites.map((s) => [s.domain, s]));
    expect(Object.keys(byDomain).sort()).toEqual([
      'blog.test',
      'laravel-app.test',
      'shop.test',
    ]);
    expect(byDomain['blog.test'].linked).toBe(true);
    expect(byDomain['blog.test'].path).toBe(
      fs.realpathSync(path.join(tmp, 'elsewhere', 'blog'))
    );
  });

  it('keeps only WordPress sites, with HTTPS, isolated PHP and wp-config values', () => {
    const sites = herd.listWordPressSites(root);
    expect(sites.map((s) => s.domain)).toEqual(['blog.test', 'shop.test']);
    const shop = sites.find((s) => s.domain === 'shop.test');
    expect(shop).toMatchObject({
      name: 'Shop',
      secured: true,
      phpVersion: '8.4',
      dbName: 'shop',
      dbHost: 'localhost',
      tablePrefix: 'wpx_',
      multisite: false,
    });
    const blog = sites.find((s) => s.domain === 'blog.test');
    expect(blog).toMatchObject({
      secured: false,
      phpVersion: '8.3',
      dbName: 'blog_linked',
    });
  });
});

describe('pure helpers', () => {
  it('parses wp-config defines and multisite', () => {
    expect(herd.parseWpConfig(wpConfig({ extra: "define('MULTISITE', true);" }))).toEqual(
      {
        dbName: 'shop',
        dbHost: 'localhost',
        tablePrefix: 'wpx_',
        multisite: true,
      }
    );
    // A computed value is not guessed.
    expect(herd.parseWpConfig("define('DB_NAME', getenv('DB'));").dbName).toBeNull();
  });

  it('knows which DB hosts are this machine’s default MySQL', () => {
    for (const h of [
      'localhost',
      '127.0.0.1',
      'localhost:3306',
      'localhost:/tmp/mysql.sock',
    ]) {
      expect(herd.isLocalDbHost(h)).toBe(true);
    }
    for (const h of ['127.0.0.1:3307', 'db.example.com', '', null]) {
      expect(herd.isLocalDbHost(h)).toBe(false);
    }
  });

  it('reads isolated PHP from a vhost', () => {
    expect(herd.isolatedPhpFromVhost('fastcgi_pass $herd_sock_74;')).toBe('7.4');
    expect(herd.isolatedPhpFromVhost('fastcgi_pass $herd_sock;')).toBeNull();
  });

  it('picks Herd’s PHP when installed, else the active one', () => {
    const installed = [
      { version: '8.2', active: false },
      { version: '8.3', active: true },
    ];
    expect(herd.pickPhpVersion('8.2', installed)).toBe('8.2');
    expect(herd.pickPhpVersion('8.4', installed)).toBe('8.3');
    expect(herd.pickPhpVersion('8.4', [])).toBeNull();
  });
});

describe('adoptionBlocker', () => {
  const base = {
    name: 'shop',
    domain: 'shop.test',
    path: '/Users/x/Herd/shop',
    dbName: 'shop',
    dbHost: 'localhost',
    multisite: false,
  };
  const ctx = (over = {}) => ({
    sites: [],
    dbExists: () => true,
    vhostExists: () => false,
    ...over,
  });
  const code = (site, c = ctx()) => herd.adoptionBlocker(site, c)?.code || null;

  it('allows a plain local site', () => {
    expect(code(base)).toBeNull();
  });

  it('blocks each case with its own reason', () => {
    expect(code(base, ctx({ sites: [{ name: 'S', domain: 'shop.test' }] }))).toBe(
      'imported'
    );
    expect(
      code(base, ctx({ sites: [{ name: 'S', domain: 'x.test', path: base.path }] }))
    ).toBe('imported');
    expect(code({ ...base, multisite: true })).toBe('multisite');
    expect(code({ ...base, dbName: null })).toBe('db-unreadable');
    expect(code({ ...base, dbName: 'seco-system' })).toBeNull(); // hyphens are fine
    expect(code({ ...base, dbName: '-flag' })).toBe('db-name-unsupported');
    expect(code({ ...base, dbName: 'a`b' })).toBe('db-name-unsupported');
    expect(code({ ...base, dbHost: '127.0.0.1:3307' })).toBe('db-elsewhere');
    expect(code(base, ctx({ dbExists: () => false }))).toBe('db-missing');
    expect(code(base, ctx({ vhostExists: () => true }))).toBe('domain-taken');
  });
});
