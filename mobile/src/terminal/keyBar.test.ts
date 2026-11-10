import { describe, expect, it } from 'vitest';
import { ctrlBytes, keyBytes, pressWithCtrlArmed, typedTextBytes, KEY_BAR_ORDER } from './keyBar';

describe('keyBytes', () => {
  it('sends Esc, Tab, Ctrl-C, arrows and Enter', () => {
    expect(keyBytes('esc')).toBe('\x1b');
    expect(keyBytes('tab')).toBe('\t');
    expect(keyBytes('ctrl-c')).toBe('\x03');
    expect(keyBytes('up')).toBe('\x1b[A');
    expect(keyBytes('down')).toBe('\x1b[B');
    expect(keyBytes('right')).toBe('\x1b[C');
    expect(keyBytes('left')).toBe('\x1b[D');
    expect(keyBytes('enter')).toBe('\r');
  });

  it('maps the keyboard Backspace to DEL, off the bar', () => {
    expect(keyBytes('backspace')).toBe('\x7f');
    expect(KEY_BAR_ORDER).not.toContain('backspace');
  });
});

describe('typedTextBytes', () => {
  it('sends the keyboard Return as a carriage return, like a terminal', () => {
    expect(typedTextBytes('\n')).toBe('\r');
    expect(typedTextBytes('yes\n')).toBe('yes\r');
    expect(typedTextBytes('a\r\nb')).toBe('a\rb');
  });

  it('leaves other text alone', () => {
    expect(typedTextBytes('hello')).toBe('hello');
    expect(typedTextBytes('\t')).toBe('\t');
  });
});

describe('ctrlBytes', () => {
  it('maps letters to control characters like the shell expects', () => {
    expect(ctrlBytes('c')).toBe('\x03');
    expect(ctrlBytes('C')).toBe('\x03');
    expect(ctrlBytes('a')).toBe('\x01');
    expect(ctrlBytes('z')).toBe('\x1a');
  });

  it('rejects anything that is not one ASCII letter', () => {
    expect(() => ctrlBytes('')).toThrow();
    expect(() => ctrlBytes('ab')).toThrow();
    expect(() => ctrlBytes('1')).toThrow();
  });
});

describe('pressWithCtrlArmed', () => {
  it('turns the next letter into its control byte and disarms', () => {
    expect(pressWithCtrlArmed({ text: 'c' }, true)).toEqual({ bytes: '\x03', ctrlArmed: false });
    expect(pressWithCtrlArmed({ text: 'G' }, true)).toEqual({ bytes: '\x07', ctrlArmed: false });
  });

  it('passes other input through and disarms', () => {
    expect(pressWithCtrlArmed({ text: 'hello' }, true)).toEqual({
      bytes: 'hello',
      ctrlArmed: false,
    });
    expect(pressWithCtrlArmed({ key: 'enter' }, true)).toEqual({ bytes: '\r', ctrlArmed: false });
  });

  it('leaves unarmed input untouched', () => {
    expect(pressWithCtrlArmed({ text: 'c' }, false)).toEqual({ bytes: 'c', ctrlArmed: false });
    expect(pressWithCtrlArmed({ key: 'up' }, false)).toEqual({ bytes: '\x1b[A', ctrlArmed: false });
  });

  it('sends a typed newline as Enter', () => {
    expect(pressWithCtrlArmed({ text: '\n' }, false)).toEqual({ bytes: '\r', ctrlArmed: false });
    expect(pressWithCtrlArmed({ key: 'backspace' }, true)).toEqual({
      bytes: '\x7f',
      ctrlArmed: false,
    });
  });
});
