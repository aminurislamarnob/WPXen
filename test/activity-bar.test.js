import { describe, it, expect } from 'vitest';
import { downCoreServices, servicesLabel, resolveLastSite } from '../src/lib/activityBar';

const up = (name) => ({ running: true, name });

const allUp = {
  nginx: up('nginx'),
  php: up('PHP-FPM'),
  mysql: up('MySQL'),
  dnsmasq: up('dnsmasq'),
  mailpit: up('Mailpit'),
};

describe('downCoreServices', () => {
  it('is empty when every core service is running', () => {
    expect(downCoreServices(allUp)).toEqual([]);
  });

  it('is empty before the first status arrives', () => {
    expect(downCoreServices(null)).toEqual([]);
  });

  it('names stopped core services', () => {
    const status = { ...allUp, mysql: { running: false, name: 'MySQL' } };
    expect(downCoreServices(status)).toEqual(['MySQL']);
  });

  it('flags a supervisor error even if a probe still sees the process', () => {
    const status = { ...allUp, php: { ...up('PHP-FPM'), error: 'crash loop' } };
    expect(downCoreServices(status)).toEqual(['PHP-FPM']);
  });

  it('ignores Mailpit', () => {
    const status = { ...allUp, mailpit: { running: false, name: 'Mailpit' } };
    expect(downCoreServices(status)).toEqual([]);
  });
});

describe('servicesLabel', () => {
  it('is the plain label when nothing is down', () => {
    expect(servicesLabel([])).toBe('Services');
  });

  it('names the culprits', () => {
    expect(servicesLabel(['MySQL'])).toBe('Services — MySQL is down');
    expect(servicesLabel(['nginx', 'MySQL'])).toBe('Services — nginx, MySQL are down');
  });
});

describe('resolveLastSite', () => {
  const sites = [{ id: 'a' }, { id: 'b' }];

  it('reopens the remembered site when it still exists', () => {
    expect(resolveLastSite('b', sites)).toBe('b');
  });

  it('falls back to the empty state for a deleted site', () => {
    expect(resolveLastSite('gone', sites)).toBeNull();
  });

  it('falls back when nothing is remembered', () => {
    expect(resolveLastSite(null, sites)).toBeNull();
  });
});
