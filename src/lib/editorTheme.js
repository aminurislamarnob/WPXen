import { createTheme } from '@uiw/codemirror-themes';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { MONO_STACK, terminalThemes, uiColors } from './theme';

// Superset derives its editor theme from the app theme rather than shipping a
// separate one: chrome comes from the UI tokens, syntax colors from the
// terminal's ANSI palette. We do the same, so the editor is guaranteed to match
// the terminal sitting next to it and both flip with the macOS appearance.
//
// The tag → ANSI mapping mirrors shared/themes/editor-theme.ts in the Superset
// source: keyword→magenta, string→green, number/class→yellow, function→blue,
// type/constant→cyan, tag/regexp→red.
function build(name) {
  const ansi = terminalThemes[name];
  const ui = uiColors[name];

  return createTheme({
    theme: name,
    settings: {
      background: ui.background,
      foreground: ui.foreground,
      caret: ansi.cursor,
      selection: ansi.selectionBackground,
      selectionMatch: ui.search,
      lineHighlight: ui.activeLine,
      gutterBackground: ui.background,
      gutterForeground: ui.muted,
      gutterActiveForeground: ui.foreground,
      gutterBorder: ui.border,
      fontFamily: MONO_STACK,
    },
    styles: [
      { tag: [t.comment, t.lineComment, t.blockComment], color: ui.comment },
      {
        tag: [
          t.keyword,
          t.modifier,
          t.controlKeyword,
          t.moduleKeyword,
          t.operatorKeyword,
        ],
        color: ansi.magenta,
      },
      { tag: [t.string, t.special(t.string), t.character], color: ansi.green },
      { tag: [t.regexp], color: ansi.red },
      { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom], color: ansi.yellow },
      {
        tag: [
          t.function(t.variableName),
          t.function(t.propertyName),
          t.definition(t.function(t.variableName)),
        ],
        color: ansi.blue,
      },
      { tag: [t.variableName, t.self], color: ui.foreground },
      { tag: [t.propertyName], color: ansi.blue },
      {
        tag: [t.className, t.typeName, t.namespace, t.definition(t.typeName)],
        color: ansi.yellow,
      },
      {
        tag: [t.constant(t.variableName), t.standard(t.variableName)],
        color: ansi.cyan,
      },
      { tag: [t.operator], color: ansi.cyan },
      { tag: [t.tagName, t.angleBracket], color: ansi.red },
      { tag: [t.attributeName], color: ansi.yellow },
      { tag: [t.attributeValue], color: ansi.green },
      { tag: [t.heading], color: ansi.red, fontWeight: 'bold' },
      { tag: [t.link, t.url], color: ansi.cyan, textDecoration: 'underline' },
      { tag: [t.emphasis], fontStyle: 'italic' },
      { tag: [t.strong], fontWeight: 'bold' },
      { tag: [t.meta, t.processingInstruction], color: ui.muted },
      { tag: [t.escape], color: ansi.cyan },
      { tag: [t.invalid], color: ansi.brightRed },
    ],
  });
}

export const editorThemes = { dark: build('dark'), light: build('light') };

// Metrics createTheme's `settings` can't express: Superset pads the content
// block vertically and each line horizontally, and sizes the line-height at
// round(fontSize × 1.5).
const FONT_SIZE = 13;

export const editorMetrics = EditorView.theme({
  '&': { fontSize: `${FONT_SIZE}px` },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: `${Math.round(FONT_SIZE * 1.5)}px`,
  },
  '.cm-content': { padding: '8px 0' },
  '.cm-line': { padding: '0 12px' },
});
