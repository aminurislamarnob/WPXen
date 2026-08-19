import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  apply,
  getTypography,
  onTypographyChange,
  terminalOptions,
  editorTypography,
} from '../src/lib/typography';
import { MONO_STACK } from '../src/lib/theme';

// Reset to defaults between tests — the module holds process-wide state
// because the terminal and editor subscribe to it rather than receiving props.
beforeEach(() => {
  apply({});
});

describe('apply', () => {
  it('falls back to defaults for keys the settings map does not carry', () => {
    apply({});
    expect(getTypography().terminal.fontSize).toBe(13);
    expect(getTypography().editor.lineHeight).toBe(1.5);
  });

  it('reads the appearance.<surface>.<key> namespace', () => {
    apply({ 'appearance.terminal.fontSize': 18, 'appearance.editor.fontSize': 15 });
    expect(getTypography().terminal.fontSize).toBe(18);
    expect(getTypography().editor.fontSize).toBe(15);
  });

  it('keeps the two blocks independent', () => {
    apply({ 'appearance.terminal.fontWeight': 700 });
    expect(getTypography().terminal.fontWeight).toBe(700);
    expect(getTypography().editor.fontWeight).toBe(400);
  });

  // The terminal block has no ligature knob: xterm can't honour one in this
  // renderer, so the key is deliberately absent rather than a silent no-op.
  it('exposes ligatures on the editor block only', () => {
    apply({ 'appearance.editor.ligatures': true });
    expect(getTypography().editor.ligatures).toBe(true);
    expect(getTypography().terminal).not.toHaveProperty('ligatures');
  });

  it('ignores a null settings map rather than resetting', () => {
    apply({ 'appearance.terminal.fontSize': 20 });
    apply(null);
    expect(getTypography().terminal.fontSize).toBe(20);
  });

  it('preserves an explicit falsy value instead of treating it as unset', () => {
    apply({
      'appearance.terminal.cursorBlink': false,
      'appearance.editor.fontWeight': 300,
    });
    expect(getTypography().terminal.cursorBlink).toBe(false);
    expect(getTypography().editor.fontWeight).toBe(300);
  });
});

describe('subscribers', () => {
  it('notifies on apply and stops after unsubscribe', () => {
    const handler = vi.fn();
    const off = onTypographyChange(handler);
    apply({ 'appearance.terminal.fontSize': 16 });
    expect(handler).toHaveBeenCalledTimes(1);
    off();
    apply({ 'appearance.terminal.fontSize': 17 });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('terminalOptions', () => {
  it('uses the built-in stack when no family is set', () => {
    expect(terminalOptions().fontFamily).toBe(MONO_STACK);
  });

  it('prepends a custom family and keeps the stack as a fallback', () => {
    apply({ 'appearance.terminal.fontFamily': 'Berkeley Mono' });
    expect(terminalOptions().fontFamily).toBe(`"Berkeley Mono", ${MONO_STACK}`);
  });

  it('strips quotes from a family so the CSS value cannot be broken out of', () => {
    apply({ 'appearance.terminal.fontFamily': 'Ev"il' });
    expect(terminalOptions().fontFamily).toBe(`"Evil", ${MONO_STACK}`);
  });

  it('treats a whitespace-only family as unset', () => {
    apply({ 'appearance.terminal.fontFamily': '   ' });
    expect(terminalOptions().fontFamily).toBe(MONO_STACK);
  });

  it('derives a bold weight without exceeding the CSS maximum', () => {
    apply({ 'appearance.terminal.fontWeight': 400 });
    expect(terminalOptions().fontWeightBold).toBe(700);
    apply({ 'appearance.terminal.fontWeight': 700 });
    expect(terminalOptions().fontWeightBold).toBe(900);
  });

  it('maps cursor and contrast onto xterm option names', () => {
    apply({
      'appearance.terminal.cursorStyle': 'bar',
      'appearance.terminal.minimumContrast': 4.5,
    });
    const opts = terminalOptions();
    expect(opts.cursorStyle).toBe('bar');
    expect(opts.minimumContrastRatio).toBe(4.5);
  });
});

describe('editorTypography', () => {
  it('emits CSS-ready strings', () => {
    apply({
      'appearance.editor.fontSize': 15,
      'appearance.editor.lineHeight': 1.8,
      'appearance.editor.fontWeight': 500,
    });
    const t = editorTypography();
    expect(t.fontSize).toBe('15px');
    expect(t.lineHeight).toBe('1.8');
    expect(t.fontWeight).toBe('500');
  });

  it("emits 'normal' letter spacing for zero rather than '0px'", () => {
    expect(editorTypography().letterSpacing).toBe('normal');
    apply({ 'appearance.editor.letterSpacing': 1.5 });
    expect(editorTypography().letterSpacing).toBe('1.5px');
  });

  it('disables ligatures by default and enables them on request', () => {
    expect(editorTypography().fontVariantLigatures).toBe('none');
    apply({ 'appearance.editor.ligatures': true });
    expect(editorTypography().fontVariantLigatures).toBe('normal');
  });
});
