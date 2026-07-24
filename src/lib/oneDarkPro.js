import { createTheme } from '@uiw/codemirror-themes';
import { tags as t } from '@lezer/highlight';

// A CodeMirror rendition of the "One Dark Pro" palette that Superset's editor
// uses (Superset renders with shiki's `one-dark-pro`; CodeMirror can't load
// shiki themes, so we map the same hex colors onto CodeMirror's highlight tags).
export const oneDarkPro = createTheme({
  theme: 'dark',
  settings: {
    background: '#282c34',
    foreground: '#abb2bf',
    caret: '#528bff',
    selection: '#3e4451',
    selectionMatch: '#3e4451',
    lineHighlight: '#2c313c',
    gutterBackground: '#282c34',
    gutterForeground: '#495162',
    gutterActiveForeground: '#abb2bf',
    gutterBorder: 'transparent',
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  },
  styles: [
    { tag: [t.comment, t.lineComment, t.blockComment], color: '#7f848e', fontStyle: 'italic' },
    { tag: [t.keyword, t.modifier, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: '#c678dd' },
    { tag: [t.string, t.special(t.string), t.regexp, t.character], color: '#98c379' },
    { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom], color: '#d19a66' },
    {
      tag: [
        t.function(t.variableName),
        t.function(t.propertyName),
        t.definition(t.function(t.variableName)),
      ],
      color: '#61afef',
    },
    { tag: [t.variableName, t.self], color: '#e06c75' },
    { tag: [t.propertyName], color: '#abb2bf' },
    { tag: [t.className, t.typeName, t.namespace, t.definition(t.typeName)], color: '#e5c07b' },
    { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: '#e5c07b' },
    { tag: [t.operator], color: '#56b6c2' },
    { tag: [t.tagName, t.angleBracket], color: '#e06c75' },
    { tag: [t.attributeName], color: '#d19a66' },
    { tag: [t.attributeValue], color: '#98c379' },
    { tag: [t.heading], color: '#e06c75', fontWeight: 'bold' },
    { tag: [t.link, t.url], color: '#56b6c2', textDecoration: 'underline' },
    { tag: [t.emphasis], fontStyle: 'italic' },
    { tag: [t.strong], fontWeight: 'bold' },
    { tag: [t.meta, t.processingInstruction], color: '#7f848e' },
    { tag: [t.escape], color: '#56b6c2' },
    { tag: [t.invalid], color: '#ffffff' },
  ],
});
