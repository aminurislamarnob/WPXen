import { describe, it, expect } from 'vitest';
import { MarkdownManager } from '@tiptap/markdown';
import { richMarkdownExtensions } from '../src/lib/richMarkdown';

// The issue editor edits GitHub markdown in place, so what comes back out
// must be what went in — anything lost here would be lost from the issue on
// Save. Parsed and re-serialised through the editor's own extensions.

const manager = new MarkdownManager({ extensions: richMarkdownExtensions() });
const roundTrip = (md) => manager.serialize(manager.parse(md)).trim();

describe('issue editor markdown round trip', () => {
  it('keeps everyday GitHub markdown', () => {
    const md = [
      '## Steps',
      '',
      '1. Open **cart** and *apply* ~~coupon~~ `SAVE10`',
      '2. See [docs](https://example.com)',
      '',
      '- [ ] todo item',
      '- [x] done item',
      '',
      '> quoted',
      '',
      '```php',
      'echo "hi";',
      '```',
      '',
      '![shot](https://github.com/user-attachments/assets/abc.png)',
    ].join('\n');
    expect(roundTrip(md)).toBe(md);
  });

  it('keeps tables', () => {
    const out = roundTrip('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(out).toMatch(/\|\s*a\s*\|\s*b\s*\|/);
    expect(out).toMatch(/\|\s*1\s*\|\s*2\s*\|/);
    expect(out).toMatch(/\|\s*-+\s*\|\s*-+\s*\|/);
  });

  it('keeps raw HTML verbatim instead of escaping it', () => {
    const out = roundTrip(
      [
        '<!-- Describe the bug -->',
        '',
        '<details><summary>Logs</summary>',
        '',
        'raw output',
        '',
        '</details>',
        '',
        'Inline <kbd>Cmd</kbd> key and <img width="200" src="https://x/y.png">',
      ].join('\n')
    );
    expect(out).toContain('<!-- Describe the bug -->');
    expect(out).toContain('<details><summary>Logs</summary>');
    expect(out).toContain('</details>');
    expect(out).toContain('<kbd>Cmd</kbd>');
    expect(out).toContain('<img width="200" src="https://x/y.png">');
    expect(out).not.toContain('&lt;');
  });

  it('leaves autolinks, code and plain angle brackets alone', () => {
    expect(roundTrip('See <https://example.com> now')).toContain('https://example.com');
    expect(roundTrip('Use `<b>` tags')).toBe('Use `<b>` tags');
    expect(roundTrip('```html\n<div class="x"></div>\n```')).toBe(
      '```html\n<div class="x"></div>\n```'
    );
    // A bare `<` may come back as `&lt;` — GitHub renders both as `<`.
    expect(roundTrip('if a < b and c > d')).toMatch(/if a (<|&lt;) b and c (>|&gt;) d/);
  });
});
