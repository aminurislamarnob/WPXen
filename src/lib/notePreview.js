import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Markdown → sanitised HTML, for a note's Preview and for issue bodies and
// comments in Tasks. Both are untrusted — a note can be any markdown file the
// user opened, an issue anything anyone wrote — so DOMPurify strips scripts,
// event handlers and javascript: URLs before it reaches the DOM.
export function renderMarkdownHtml(text) {
  const html = marked.parse(String(text || ''), {
    gfm: true,
    breaks: false,
    async: false,
  });
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

// Only web links leave rendered markdown, and only through the app's link
// path.
export function previewLinkTarget(href) {
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
