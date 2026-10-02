import { Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';

// The TipTap extensions behind Tasks' issue editor, kept apart from React so
// the markdown round trip — GitHub markdown in, the same markdown out — is
// testable in plain Node.
//
// StarterKit covers headings, emphasis, lists, quotes, code and links; task
// lists, images and tables are added because GitHub issues use them. What
// the editor has no node for is raw HTML: issue templates are full of
// `<!-- comments -->`, `<details>` and `<img width=…>`. Without these two
// nodes that HTML comes back escaped (`&lt;details&gt;`) and editing a
// description would corrupt it. They hold the HTML verbatim and show it as
// source; it's never rendered as live HTML inside the editor.

function rawNode({ name, inline }) {
  return Node.create({
    name,
    group: inline ? 'inline' : 'block',
    inline,
    atom: true,
    selectable: true,
    addAttributes() {
      return { raw: { default: '' } };
    },
    parseHTML() {
      return [
        {
          tag: `${inline ? 'span' : 'div'}[data-${name}]`,
          getAttrs: (el) => ({ raw: el.getAttribute('data-raw') || '' }),
        },
      ];
    },
    renderHTML({ node }) {
      return [
        inline ? 'span' : 'div',
        { [`data-${name}`]: '', 'data-raw': node.attrs.raw, class: 'raw-markdown-html' },
        node.attrs.raw,
      ];
    },
    renderMarkdown: (node) => node.attrs?.raw || '',
  });
}

// An inline tag or comment (Orca's pattern): `<kbd>`, `</kbd>`, `<br/>`,
// `<img width="200" src=…>`, `<!-- … -->`. Autolinks like `<https://…>` and
// `<a@b.c>` don't match, so they stay links.
const INLINE_HTML = /^(?:<!--[\s\S]*?-->|<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*?)?\/?>)/;

// Inline HTML needs its own tokenizer: marked's `html` tokens inside a
// paragraph never reach an extension's handler, and would be escaped.
const RawHtmlInline = rawNode({ name: 'rawHtmlInline', inline: true }).extend({
  markdownTokenName: 'rawHtmlInline',
  markdownTokenizer: {
    name: 'rawHtmlInline',
    level: 'inline',
    start: (src) => {
      const i = src.search(/<(?:[A-Za-z/]|!--)/);
      return i;
    },
    tokenize: (src) => {
      const m = src.match(INLINE_HTML);
      return m ? { type: 'rawHtmlInline', raw: m[0], text: m[0] } : undefined;
    },
  },
  parseMarkdown: (token) => ({
    type: 'rawHtmlInline',
    attrs: { raw: String(token.raw) },
  }),
});

// Owns marked's `html` token, which is both block HTML (its own lines) and
// inline HTML (inside a paragraph); each becomes the matching raw node.
const RawHtmlBlock = rawNode({ name: 'rawHtmlBlock', inline: false }).extend({
  markdownTokenName: 'html',
  parseMarkdown: (token) => {
    const raw = String(token.raw || token.text || '');
    return token.block
      ? { type: 'rawHtmlBlock', attrs: { raw: raw.replace(/\n+$/, '') } }
      : { type: 'rawHtmlInline', attrs: { raw } };
  },
});

export function richMarkdownExtensions() {
  return [
    StarterKit.configure({
      link: { openOnClick: false, autolink: true, linkOnPaste: true },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Image,
    TableKit.configure({ table: { resizable: false } }),
    RawHtmlBlock,
    RawHtmlInline,
  ];
}
