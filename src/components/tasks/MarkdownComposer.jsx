import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { Markdown } from '@tiptap/markdown';
import Placeholder from '@tiptap/extension-placeholder';
import { richMarkdownExtensions } from '../../lib/richMarkdown';
import {
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  ImageIcon,
  Link as LinkIcon,
  List,
  ListOrdered,
  ListTodo,
  MoreHorizontal,
  Pilcrow,
  Quote,
} from 'lucide-react';
import { Tooltip } from '../ui';
import { Popover } from './pickers';

// The issue editor, after Orca's GitHubMarkdownComposer: a WYSIWYG markdown
// editor (TipTap) under a formatting toolbar — body text and headings, bold /
// italic / strike, lists and checklists, quote, link, image, and a "more"
// menu. It reads and writes GitHub-flavoured markdown, so what's typed here
// is exactly what GitHub stores.
//
// ⌘↩ calls `onSubmit`; ⌘K edits the link under the cursor. When the parent
// clears `value` (after a comment posts) the editor clears with it.

const URL_OK = /^https?:\/\/\S+$/i;

function ToolbarButton({ label, onClick, active = false, children }) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        className={`rich-markdown-toolbar-button ${active ? 'is-active' : ''}`}
        // Keep the editor's selection: a toolbar click must not blur it.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function Separator() {
  return <div className="rich-markdown-toolbar-separator" />;
}

function MoreBlocks({ editor }) {
  const [anchor, setAnchor] = useState(null);
  const pick = (level) => {
    setAnchor(null);
    editor?.chain().focus().toggleHeading({ level }).run();
  };
  return (
    <>
      <Tooltip label="More blocks">
        <button
          type="button"
          aria-label="More blocks"
          className="rich-markdown-toolbar-button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        >
          <MoreHorizontal size={14} />
        </button>
      </Tooltip>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={170}>
          <div className="px-2.5 pt-1 pb-0.5 text-[11px] font-medium text-muted-foreground">
            Headings
          </div>
          {[
            [4, Heading4],
            [5, Heading5],
          ].map(([level, Icon]) => (
            <button
              key={level}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(level)}
              className="flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-[12.5px] text-foreground hover:bg-accent"
            >
              <Icon size={14} />
              Heading {level}
            </button>
          ))}
        </Popover>
      )}
    </>
  );
}

// The URL row under the toolbar, for a link or an image — Orca's image row,
// used for both.
function UrlRow({ kind, initial, onInsert, onRemove, onCancel, disabled }) {
  const [url, setUrl] = useState(initial || '');
  const ref = useRef(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <form
      className="github-markdown-composer-image-row"
      onSubmit={(e) => {
        e.preventDefault();
        if (URL_OK.test(url.trim())) onInsert(url.trim());
      }}
    >
      {kind === 'image' ? (
        <ImageIcon size={14} className="flex-shrink-0 text-muted-foreground" />
      ) : (
        <LinkIcon size={14} className="flex-shrink-0 text-muted-foreground" />
      )}
      <input
        ref={ref}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        placeholder="https://..."
        disabled={disabled}
        className="form-input !h-7 min-w-0 flex-1 !text-[12px]"
      />
      <button
        type="submit"
        className="btn btn-primary !h-7 !px-2.5 !text-[12px]"
        disabled={disabled || !URL_OK.test(url.trim())}
      >
        {kind === 'link' && initial ? 'Update' : 'Insert'}
      </button>
      {onRemove && (
        <button
          type="button"
          className="btn btn-ghost !h-7 !px-2.5 !text-[12px]"
          onClick={onRemove}
        >
          Remove
        </button>
      )}
      <button
        type="button"
        className="btn btn-ghost !h-7 !px-2.5 !text-[12px]"
        onClick={onCancel}
      >
        Cancel
      </button>
    </form>
  );
}

export default function MarkdownComposer({
  value,
  onChange,
  placeholder,
  minHeightClassName = 'min-h-32',
  className = '',
  disabled = false,
  autoFocus = false,
  onSubmit,
}) {
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);
  onChangeRef.current = onChange;
  onSubmitRef.current = onSubmit;
  // The last markdown the editor reported, so an echo of it from the parent
  // isn't pushed back in (which would move the cursor).
  const lastSynced = useRef(value);
  const applyingExternal = useRef(false);
  const [urlRow, setUrlRow] = useState(null); // { kind: 'link' | 'image', initial }
  // Toolbar active states follow the selection; bump to re-render on change.
  const [, setTick] = useState(0);
  // ⌘K is handled inside the editor's own key handler, set up once; it calls
  // through this ref to the current link opener.
  const openLinkRowRef = useRef(() => {});

  const extensions = useMemo(
    () => [
      ...richMarkdownExtensions(),
      Markdown,
      Placeholder.configure({ placeholder, includeChildren: true }),
    ],
    [placeholder]
  );

  const editor = useEditor({
    extensions,
    content: value || '',
    contentType: 'markdown',
    editable: !disabled,
    editorProps: {
      attributes: {
        class: `rich-markdown-editor github-markdown-composer-editor ${minHeightClassName}`,
      },
      handleKeyDown: (_view, event) => {
        if (
          event.key === 'Enter' &&
          (event.metaKey || event.ctrlKey) &&
          onSubmitRef.current
        ) {
          event.preventDefault();
          onSubmitRef.current();
          return true;
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
          event.preventDefault();
          openLinkRowRef.current();
          return true;
        }
        return false;
      },
    },
    onCreate: ({ editor: e }) => {
      lastSynced.current = value;
      if (autoFocus) requestAnimationFrame(() => e.commands.focus('end'));
    },
    onUpdate: ({ editor: e }) => {
      if (applyingExternal.current) return;
      const markdown = e.getMarkdown();
      lastSynced.current = markdown;
      onChangeRef.current(markdown);
    },
    onSelectionUpdate: () => setTick((n) => n + 1),
    onTransaction: () => setTick((n) => n + 1),
  });

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  // Follow the parent: a cleared value (comment posted) or a fresh draft
  // (Edit pressed again) replaces the content; our own echo is ignored.
  useEffect(() => {
    if (!editor) return;
    const next = value || '';
    if (next === lastSynced.current || next === editor.getMarkdown()) {
      lastSynced.current = next;
      return;
    }
    applyingExternal.current = true;
    try {
      if (next.trim()) {
        editor.commands.setContent(next, { contentType: 'markdown', emitUpdate: false });
      } else {
        editor.commands.clearContent(false);
      }
      lastSynced.current = next;
    } finally {
      applyingExternal.current = false;
    }
  }, [editor, value]);

  const openLinkRow = useCallback(() => {
    if (!editor || disabled) return;
    const href = editor.isActive('link') ? editor.getAttributes('link').href || '' : '';
    setUrlRow({ kind: 'link', initial: href });
  }, [editor, disabled]);
  openLinkRowRef.current = openLinkRow;

  const insertUrl = (url) => {
    const kind = urlRow?.kind;
    setUrlRow(null);
    if (!editor) return;
    if (kind === 'image') {
      editor.chain().focus().setImage({ src: url }).run();
      return;
    }
    if (editor.isActive('link')) {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    } else if (editor.state.selection.empty) {
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'text',
          text: url,
          marks: [{ type: 'link', attrs: { href: url } }],
        })
        .run();
    } else {
      editor.chain().focus().setLink({ href: url }).run();
    }
  };

  const removeLink = () => {
    setUrlRow(null);
    editor?.chain().focus().extendMarkRange('link').unsetLink().run();
  };

  const run = (fn) => () => editor && fn(editor.chain().focus());
  const is = (name, attrs) => !!editor?.isActive(name, attrs);

  return (
    <div
      className={`github-markdown-composer relative overflow-hidden rounded-md border border-input bg-background shadow-sm ${
        disabled ? 'opacity-60' : ''
      } ${className}`}
    >
      <div className="rich-markdown-editor-toolbar">
        <ToolbarButton
          label="Body text"
          active={is('paragraph') && !is('bulletList') && !is('orderedList')}
          onClick={run((c) => c.setParagraph().run())}
        >
          <Pilcrow size={14} />
        </ToolbarButton>
        {[
          [1, Heading1],
          [2, Heading2],
          [3, Heading3],
        ].map(([level, Icon]) => (
          <ToolbarButton
            key={level}
            label={`Heading ${level}`}
            active={is('heading', { level })}
            onClick={run((c) => c.toggleHeading({ level }).run())}
          >
            <Icon size={14} />
          </ToolbarButton>
        ))}
        <Separator />
        <ToolbarButton
          label="Bold"
          active={is('bold')}
          onClick={run((c) => c.toggleBold().run())}
        >
          B
        </ToolbarButton>
        <ToolbarButton
          label="Italic"
          active={is('italic')}
          onClick={run((c) => c.toggleItalic().run())}
        >
          <span className="italic">I</span>
        </ToolbarButton>
        <ToolbarButton
          label="Strike"
          active={is('strike')}
          onClick={run((c) => c.toggleStrike().run())}
        >
          <span className="line-through">S</span>
        </ToolbarButton>
        <Separator />
        <ToolbarButton
          label="Bullet list"
          active={is('bulletList')}
          onClick={run((c) => c.toggleBulletList().run())}
        >
          <List size={14} />
        </ToolbarButton>
        <ToolbarButton
          label="Numbered list"
          active={is('orderedList')}
          onClick={run((c) => c.toggleOrderedList().run())}
        >
          <ListOrdered size={14} />
        </ToolbarButton>
        <ToolbarButton
          label="Checklist"
          active={is('taskList')}
          onClick={run((c) => c.toggleTaskList().run())}
        >
          <ListTodo size={14} />
        </ToolbarButton>
        <Separator />
        <ToolbarButton
          label="Quote"
          active={is('blockquote')}
          onClick={run((c) => c.toggleBlockquote().run())}
        >
          <Quote size={14} />
        </ToolbarButton>
        <ToolbarButton label="Link (⌘K)" active={is('link')} onClick={openLinkRow}>
          <LinkIcon size={14} />
        </ToolbarButton>
        <ToolbarButton
          label="Image"
          onClick={() => setUrlRow({ kind: 'image', initial: '' })}
        >
          <ImageIcon size={14} />
        </ToolbarButton>
        <MoreBlocks editor={editor} />
      </div>
      {urlRow && (
        <UrlRow
          key={urlRow.kind}
          kind={urlRow.kind}
          initial={urlRow.initial}
          disabled={disabled}
          onInsert={insertUrl}
          onRemove={urlRow.kind === 'link' && urlRow.initial ? removeLink : null}
          onCancel={() => {
            setUrlRow(null);
            editor?.commands.focus();
          }}
        />
      )}
      <div className="relative max-h-[360px] overflow-y-auto">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
