import { describe, it, expect } from 'vitest';
import { sanitizeUrl, displayUrl } from '../src/lib/browser/sanitizeUrl.js';
import browser from '../electron/services/browser.cjs';

// The renderer and the main process each sanitize (a URL can arrive from either
// the address bar or IPC), so both copies are held to the same table.
const cases = [
  ['https://wpherd.test', 'https://wpherd.test'],
  ['http://wpherd.test/wp-admin', 'http://wpherd.test/wp-admin'],
  ['about:blank', 'about:blank'],
  // Bare hosts are https by default…
  ['wpherd.test', 'https://wpherd.test'],
  ['phpmyadmin.test/index.php?route=/', 'https://phpmyadmin.test/index.php?route=/'],
  // …but loopback isn't served over TLS, so don't pretend it is.
  ['localhost:8025', 'http://localhost:8025'],
  ['localhost', 'http://localhost'],
  ['127.0.0.1:3306', 'http://127.0.0.1:3306'],
  // No dot, or spaces, means it was never a host.
  ['wordpress', 'https://www.google.com/search?q=wordpress'],
  ['why is php slow', 'https://www.google.com/search?q=why%20is%20php%20slow'],
  [
    'wp cli db.export help',
    'https://www.google.com/search?q=wp%20cli%20db.export%20help',
  ],
  ['', 'about:blank'],
  ['   ', 'about:blank'],
];

describe('sanitizeUrl', () => {
  for (const [input, expected] of cases) {
    it(`renderer: ${JSON.stringify(input)} → ${expected}`, () => {
      expect(sanitizeUrl(input)).toBe(expected);
    });
    it(`main: ${JSON.stringify(input)} → ${expected}`, () => {
      expect(browser.sanitizeUrl(input)).toBe(expected);
    });
  }

  it('treats null and undefined as blank', () => {
    expect(sanitizeUrl(null)).toBe('about:blank');
    expect(sanitizeUrl(undefined)).toBe('about:blank');
    expect(browser.sanitizeUrl(null)).toBe('about:blank');
  });

  it('does not mistake a localhost-prefixed host for loopback', () => {
    expect(sanitizeUrl('localhost.example.com')).toBe('https://localhost.example.com');
  });
});

describe('displayUrl', () => {
  it('hides about:blank', () => {
    expect(displayUrl('about:blank')).toBe('');
    expect(displayUrl('')).toBe('');
    expect(displayUrl(null)).toBe('');
  });

  it('drops a bare trailing slash', () => {
    expect(displayUrl('https://wpherd.test/')).toBe('https://wpherd.test');
  });

  it('leaves a path alone', () => {
    expect(displayUrl('https://wpherd.test/wp-admin')).toBe(
      'https://wpherd.test/wp-admin'
    );
  });
});
