import { useMemo } from 'react';
import { previewLinkTarget, renderMarkdownHtml } from '../../lib/notePreview';

// GitHub-flavoured markdown rendered for Tasks (issue bodies, comments). The
// editor side is MarkdownComposer.

export function Markdown({ text, onLink, empty }) {
  // Sanitised by DOMPurify in renderMarkdownHtml.
  const html = useMemo(() => renderMarkdownHtml(text), [text]);
  if (!String(text || '').trim()) {
    return <p className="text-[13px] italic text-muted-foreground">{empty}</p>;
  }
  // Links never navigate the app's own window; they go through the app's
  // link setting instead.
  const onClick = (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    const url = previewLinkTarget(a.getAttribute('href'));
    if (url && onLink) onLink(url);
  };
  return (
    <div
      className="note-preview break-words"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
