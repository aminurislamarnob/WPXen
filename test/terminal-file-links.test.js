import { describe, it, expect } from 'vitest';
import { extractFileCandidates } from '../src/lib/terminal/fileLinks.js';

describe('extractFileCandidates', () => {
  it('finds a relative path with slashes', () => {
    const [c] = extractFileCandidates('see wp-content/themes/x.php for details');
    expect(c.text).toBe('wp-content/themes/x.php');
    expect(c.line).toBeUndefined();
  });

  it('parses :line:col suffix', () => {
    const [c] = extractFileCandidates('error at src/app.js:42:7 here');
    expect(c.text).toBe('src/app.js');
    expect(c.line).toBe(42);
    expect(c.col).toBe(7);
  });

  it('parses :line only', () => {
    const [c] = extractFileCandidates('src/app.js:10');
    expect(c.line).toBe(10);
    expect(c.col).toBeUndefined();
  });

  it('finds a bare name.ext word', () => {
    const cands = extractFileCandidates('edit AGENTS.md now');
    expect(cands.some((c) => c.text === 'AGENTS.md')).toBe(true);
  });

  it('reports correct column offsets', () => {
    const text = 'x wp-content/a.php';
    const [c] = extractFileCandidates(text);
    expect(text.slice(c.start, c.end)).toBe('wp-content/a.php');
  });

  it('finds an absolute path', () => {
    const [c] = extractFileCandidates('open /Users/dev/site/wp-config.php');
    expect(c.text).toBe('/Users/dev/site/wp-config.php');
  });

  it('ignores lines over the length cap', () => {
    expect(extractFileCandidates('a/b '.repeat(600))).toEqual([]);
  });

  it('returns empty for plain prose', () => {
    expect(extractFileCandidates('just some words here')).toEqual([]);
  });

  it('caps at 10 links per line', () => {
    const many = Array.from({ length: 20 }, (_, i) => `d/f${i}.php`).join(' ');
    expect(extractFileCandidates(many).length).toBeLessThanOrEqual(10);
  });
});
