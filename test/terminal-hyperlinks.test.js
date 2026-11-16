import { describe, it, expect } from 'vitest';
import { classifyHyperlink } from '../src/lib/terminal/hyperlinks.js';

describe('classifyHyperlink (OSC 8 targets)', () => {
  it('passes http and https through as web links', () => {
    expect(classifyHyperlink('https://shop.test/wp-admin')).toEqual({
      kind: 'web',
      uri: 'https://shop.test/wp-admin',
    });
    expect(classifyHyperlink('http://localhost:8025/')).toEqual({
      kind: 'web',
      uri: 'http://localhost:8025/',
    });
  });

  it('turns file URIs into a decoded path', () => {
    expect(classifyHyperlink('file:///Users/me/Sites/My%20Shop/wp-config.php')).toEqual({
      kind: 'file',
      path: '/Users/me/Sites/My Shop/wp-config.php',
      line: undefined,
      col: undefined,
    });
  });

  it('accepts a hostname on file URIs, as some tools write one', () => {
    expect(classifyHyperlink('file://my-mac.local/tmp/a.php').path).toBe('/tmp/a.php');
  });

  it('reads line and column fragments', () => {
    expect(classifyHyperlink('file:///a.php#L12')).toMatchObject({
      line: 12,
      col: undefined,
    });
    expect(classifyHyperlink('file:///a.php#12:4')).toMatchObject({ line: 12, col: 4 });
    expect(classifyHyperlink('file:///a.php#section')).toMatchObject({ line: undefined });
  });

  it('refuses every other scheme', () => {
    for (const uri of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'vscode://file/a.php',
      'ssh://host',
      'about:blank',
    ]) {
      expect(classifyHyperlink(uri)).toBeNull();
    }
  });

  it('refuses credentials, junk and oversized input', () => {
    expect(classifyHyperlink('https://user:pw@example.com/')).toBeNull();
    expect(classifyHyperlink('not a url')).toBeNull();
    expect(classifyHyperlink('')).toBeNull();
    expect(classifyHyperlink(undefined)).toBeNull();
    expect(classifyHyperlink('https://a.test/' + 'x'.repeat(5000))).toBeNull();
    expect(classifyHyperlink('file:///a%00b')).toBeNull();
  });
});
