import { highlightCode } from '@lezer/highlight';
import { languageFor } from './editorLanguage';

// Fence labels Agents write → the file extension languageFor() knows. Claude
// labels most blocks by language name (```javascript, ```python), not by
// extension, so without this most chat code went unhighlighted.
const FENCE_ALIASES = {
  javascript: 'js',
  node: 'js',
  typescript: 'ts',
  python: 'py',
  py3: 'py',
  markdown: 'md',
  yml: 'yaml',
  htm: 'html',
};

// The Lezer parser for a fence label, or null when the editor has no
// language for it (shell, diff, plain text stay as they are).
export function parserForFence(lang) {
  const label = String(lang || '')
    .trim()
    .toLowerCase();
  if (!label) return null;
  const ext = FENCE_ALIASES[label] || label;
  for (const support of languageFor(`file.${ext}`)) {
    const parser = support?.language?.parser;
    if (parser) return parser;
  }
  return null;
}

// Code → [{ text, classes }] under `highlighter` (a HighlightStyle built from
// the editor's specs), so chat code wears the editor's palette. Pure: the
// chat view turns segments into spans, tests read them directly. Null when
// the fence names no language the editor knows.
export function highlightSegments(code, lang, highlighter) {
  const parser = parserForFence(lang);
  if (!parser) return null;
  const segments = [];
  highlightCode(
    code,
    parser.parse(code),
    highlighter,
    (text, classes) => text && segments.push({ text, classes: classes || '' }),
    () => segments.push({ text: '\n', classes: '' })
  );
  return segments;
}
