import { describe, it, expect } from 'vitest';
import { HighlightStyle } from '@codemirror/language';
import { highlightSpecs } from '../src/lib/editorTheme.js';
import { parserForFence, highlightSegments } from '../src/lib/chatHighlight.js';

// Chat code blocks wear the editor's palette: the same specs build the
// highlight style, and fence labels map onto the editor's languages.
describe('chat code highlighting', () => {
  const style = HighlightStyle.define(highlightSpecs('dark'));

  it('maps the language names Agents write onto editor languages', () => {
    for (const lang of [
      'javascript',
      'js',
      'typescript',
      'python',
      'php',
      'json',
      'yml',
    ]) {
      expect(parserForFence(lang), lang).not.toBeNull();
    }
    expect(parserForFence('bash')).toBeNull();
    expect(parserForFence('')).toBeNull();
  });

  it('splits code into classed spans that rebuild the source', () => {
    const code = 'const total = 42;\nreturn "ok";';
    const segments = highlightSegments(code, 'javascript', style);
    expect(segments.map((s) => s.text).join('')).toBe(code);
    const keyword = segments.find((s) => s.text === 'const');
    expect(keyword.classes).not.toBe('');
    expect(segments.find((s) => s.text === '"ok"').classes).not.toBe(keyword.classes);
  });

  it('leaves unknown languages alone', () => {
    expect(highlightSegments('ls -la', 'bash', style)).toBeNull();
  });
});
