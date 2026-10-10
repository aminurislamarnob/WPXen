import { useState, useEffect, useRef, useMemo } from 'react';
import { Markdown } from '../tasks/markdown';
import { HighlightStyle } from '@codemirror/language';
import { highlightCode } from '@lezer/highlight';
import { languageFor } from '../../lib/editorLanguage';
import { highlightSpecs } from '../../lib/editorTheme';
import { themeName, onThemeChange } from '../../lib/theme';

const styleCache = new Map();
function getSharedHighlightStyle(appearance) {
  if (!styleCache.has(appearance)) {
    styleCache.set(appearance, HighlightStyle.define(highlightSpecs(appearance)));
  }
  return styleCache.get(appearance);
}

export function ChatMarkdown({ text, onLink, empty }) {
  const containerRef = useRef(null);
  const [appearance, setAppearance] = useState(themeName);
  useEffect(() => onThemeChange(setAppearance), []);
  const style = useMemo(() => getSharedHighlightStyle(appearance), [appearance]);

  useEffect(() => {
    if (!containerRef.current) return;
    const blocks = containerRef.current.querySelectorAll('pre code[class^="language-"]');
    if (blocks.length === 0) return;

    for (const code of blocks) {
      if (code.dataset.highlighted) continue;
      code.dataset.highlighted = 'true';
      const langMatch = code.className.match(/language-([a-zA-Z0-9_+-]+)/);
      if (!langMatch) continue;
      const extList = languageFor(`file.${langMatch[1]}`);
      if (!extList || extList.length === 0) continue;

      let parser = null;
      for (const ext of extList) {
        if (ext.language && ext.language.parser) {
          parser = ext.language.parser;
          break;
        }
      }
      if (!parser) continue;

      const source = code.textContent;
      let fragment = document.createDocumentFragment();
      const putText = (t, classes) => {
        if (!t) return;
        if (classes) {
          const span = document.createElement('span');
          span.className = classes;
          span.textContent = t;
          fragment.appendChild(span);
        } else {
          fragment.appendChild(document.createTextNode(t));
        }
      };
      const putBreak = () => {
        fragment.appendChild(document.createTextNode('\n'));
      };

      try {
        const tree = parser.parse(source);
        highlightCode(source, tree, style, putText, putBreak);
        code.innerHTML = '';
        code.appendChild(fragment);
      } catch (_err) {
        // parser failed
      }
    }
  }, [text, style]);

  return (
    <div ref={containerRef}>
      {style.module && (
        <style dangerouslySetInnerHTML={{ __html: style.module.getRules() }} />
      )}
      <Markdown text={text} onLink={onLink} empty={empty} />
    </div>
  );
}
