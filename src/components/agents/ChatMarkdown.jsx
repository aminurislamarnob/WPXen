import { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { Markdown } from '../tasks/markdown';
import { HighlightStyle } from '@codemirror/language';
import { highlightSpecs } from '../../lib/editorTheme';
import { highlightSegments } from '../../lib/chatHighlight';
import { themeName, onThemeChange } from '../../lib/theme';

const styleCache = new Map();
function getSharedHighlightStyle(appearance) {
  if (!styleCache.has(appearance)) {
    styleCache.set(appearance, HighlightStyle.define(highlightSpecs(appearance)));
  }
  return styleCache.get(appearance);
}

// Assistant markdown with code blocks highlighted statically in the editor's
// palette — no CodeMirror instance per block. Each block remembers which
// appearance coloured it: the class names belong to that appearance's style,
// so a light/dark flip re-highlights rather than leaving classes no rule
// matches any more.
export function ChatMarkdown({ text, onLink, empty }) {
  const containerRef = useRef(null);
  const [appearance, setAppearance] = useState(themeName);
  useEffect(() => onThemeChange(setAppearance), []);
  const style = useMemo(() => getSharedHighlightStyle(appearance), [appearance]);

  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const blocks = containerRef.current.querySelectorAll('pre code[class*="language-"]');
    for (const code of blocks) {
      if (code.dataset.highlighted === appearance) continue;
      const lang = /language-([\w+-]+)/.exec(code.className)?.[1];
      let segments = null;
      try {
        segments = highlightSegments(code.textContent, lang, style);
      } catch {
        segments = null; // a parser failure leaves the block plain
      }
      code.dataset.highlighted = appearance;
      if (!segments) continue;
      const fragment = document.createDocumentFragment();
      for (const { text: part, classes } of segments) {
        if (!classes) {
          fragment.appendChild(document.createTextNode(part));
          continue;
        }
        const span = document.createElement('span');
        span.className = classes;
        span.textContent = part;
        fragment.appendChild(span);
      }
      code.replaceChildren(fragment);
    }
  }, [text, style, appearance]);

  return (
    <div ref={containerRef}>
      {style.module && (
        <style dangerouslySetInnerHTML={{ __html: style.module.getRules() }} />
      )}
      <Markdown text={text} onLink={onLink} empty={empty} />
    </div>
  );
}
