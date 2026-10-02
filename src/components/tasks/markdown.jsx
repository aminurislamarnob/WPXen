import { useMemo, useState } from 'react';
import { previewLinkTarget, renderMarkdownHtml } from '../../lib/notePreview';

// GitHub-flavoured markdown for Tasks — rendered (issue bodies, comments) and
// written (the comment box, body edits, New Issue).

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

// A textarea with Write / Preview tabs, GitHub's comment-box shape. ⌘↩
// submits through `onSubmit` when given.
export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  onLink,
  onSubmit,
  rows = 5,
  autoFocus = false,
}) {
  const [tab, setTab] = useState('write');
  const tabClass = (t) =>
    `h-7 px-2.5 rounded-sm text-[12px] font-medium ${
      tab === t
        ? 'bg-muted text-foreground'
        : 'text-muted-foreground hover:text-foreground'
    }`;
  return (
    <div className="rounded-md border border-input bg-background overflow-hidden">
      <div className="flex items-center gap-1 px-1.5 py-1 border-b border-border bg-tertiary">
        <button
          type="button"
          className={tabClass('write')}
          onClick={() => setTab('write')}
        >
          Write
        </button>
        <button
          type="button"
          className={tabClass('preview')}
          onClick={() => setTab('preview')}
        >
          Preview
        </button>
      </div>
      {tab === 'write' ? (
        <textarea
          value={value}
          autoFocus={autoFocus}
          rows={rows}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.metaKey && onSubmit) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder={placeholder}
          className="block w-full resize-y bg-transparent px-3 py-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
        />
      ) : (
        <div className="px-3 py-2 min-h-[96px]">
          <Markdown text={value} onLink={onLink} empty="Nothing to preview." />
        </div>
      )}
    </div>
  );
}
