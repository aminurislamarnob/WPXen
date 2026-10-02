import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Markdown → sanitised HTML for a note's Preview. A note can be any markdown
// file the user opened, so its HTML is untrusted: DOMPurify strips scripts,
// event handlers and javascript: URLs before it reaches the DOM.
export function renderNoteHtml(text) {
  const html = marked.parse(String(text || ''), {
    gfm: true,
    breaks: false,
    async: false,
  });
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

// Only web links leave a preview, and only through the app's link path.
export function previewLinkTarget(href) {
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
