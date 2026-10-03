import { describe, it, expect } from 'vitest';
import { previewLinkTarget } from '../src/lib/notePreview';

// renderMarkdownHtml needs a DOM for DOMPurify, which the test env doesn't have;
// the link rule — what a click in a Preview may open — is pure.
describe('previewLinkTarget', () => {
  it('lets web links through', () => {
    expect(previewLinkTarget('https://shop.test/cart')).toBe('https://shop.test/cart');
    expect(previewLinkTarget('http://blog.test')).toBe('http://blog.test/');
  });

  it('opens nothing else', () => {
    for (const href of [
      'javascript:alert(1)',
      'file:///etc/hosts',
      'mailto:me@example.com',
      '#heading',
      'relative/page.md',
      '',
      null,
    ]) {
      expect(previewLinkTarget(href)).toBeNull();
    }
  });
});
