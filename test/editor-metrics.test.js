import { describe, it, expect } from 'vitest';
import { editorMetricsSpec } from '../src/lib/editorTheme';

const TYPO = {
  fontFamily: '"Fira Code", monospace',
  fontSize: '14px',
  lineHeight: '1.8',
  letterSpacing: '0.5px',
  fontWeight: '500',
  fontVariantLigatures: 'normal',
};

describe('editorMetricsSpec', () => {
  // Regression guard: @uiw/codemirror-themes emits its own
  // `&.cm-editor .cm-scroller { font-family }`. A plain `.cm-scroller` rule
  // loses to it on specificity, which silently pinned the editor font and made
  // Settings -> Appearance -> Font family a no-op.
  it('puts the scroller rules on a selector that outspecifies the theme', () => {
    const spec = editorMetricsSpec(TYPO);
    expect(spec).toHaveProperty('&.cm-editor .cm-scroller');
    expect(spec['.cm-scroller']).toBeUndefined();
  });

  it('carries every typography value through to a rule', () => {
    const spec = editorMetricsSpec(TYPO);
    const scroller = spec['&.cm-editor .cm-scroller'];
    expect(scroller.fontFamily).toBe(TYPO.fontFamily);
    expect(scroller.lineHeight).toBe(TYPO.lineHeight);
    expect(scroller.letterSpacing).toBe(TYPO.letterSpacing);
    expect(scroller.fontVariantLigatures).toBe(TYPO.fontVariantLigatures);
    expect(spec['&'].fontSize).toBe(TYPO.fontSize);
    expect(spec['&'].fontWeight).toBe(TYPO.fontWeight);
  });

  it('tracks the argument rather than a module-level snapshot', () => {
    const a = editorMetricsSpec({ ...TYPO, fontSize: '11px' });
    const b = editorMetricsSpec({ ...TYPO, fontSize: '22px' });
    expect(a['&'].fontSize).toBe('11px');
    expect(b['&'].fontSize).toBe('22px');
  });
});
