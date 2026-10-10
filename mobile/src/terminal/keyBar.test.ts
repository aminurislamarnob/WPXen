import { describe, expect, it } from 'vitest';
import { ctrlBytes, keyBytes, pressWithCtrlArmed } from './keyBar';

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
});
