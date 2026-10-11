// Phone key-bar byte mapping (desktop: src/lib/terminal/keys.js). Arrows are
// CSI, Ctrl+letter masks to 0x1f — the same bytes the desktop sends, so TUIs
// cannot tell phone input apart. Control codes are built with
// String.fromCharCode so this file carries no raw control bytes.
//
// Backspace is not on the bar: the soft keyboard has its own, which reaches
// the screen as a key press rather than as text (the hidden field is always
// empty, so there is nothing to delete locally) and maps to DEL here, the
// byte a terminal emulator sends for it (after Orca terminal-key-definitions).

const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;

export type KeyId =
  | 'esc'
  | 'tab'
  | 'ctrl-c'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'enter'
  | 'backspace';

const BYTES: Record<KeyId, string> = {
  esc: ESC,
  tab: String.fromCharCode(9),
  'ctrl-c': String.fromCharCode(3),
  up: `${CSI}A`,
  down: `${CSI}B`,
  right: `${CSI}C`,
  left: `${CSI}D`,
  enter: String.fromCharCode(13),
  backspace: String.fromCharCode(127),
};

export const KEY_BAR_ORDER: KeyId[] = [
  'esc',
  'tab',
  'ctrl-c',
  'up',
  'down',
  'left',
  'right',
  'enter',
];

export function keyBytes(id: KeyId): string {
  const bytes = BYTES[id];
  if (bytes === undefined) throw new Error(`Unknown key: ${String(id)}`);
  return bytes;
}

// A single ASCII letter held under the Ctrl toggle: uppercased, then masked
// to its control character, exactly like a terminal Ctrl chord.
export function ctrlBytes(letter: string): string {
  if (!/^[A-Za-z]$/.test(letter)) throw new Error('Ctrl needs one ASCII letter.');
  return String.fromCharCode(letter.toUpperCase().charCodeAt(0) & 0x1f);
}

export type KeyPress = { text: string } | { key: KeyId };

// Text the soft keyboard typed, as a terminal emulator would send it: its
// Return key arrives as a newline, but Enter on a terminal is a carriage
// return — a TUI reads a bare newline as nothing it recognises.
export function typedTextBytes(text: string): string {
  return text.replace(/\r?\n/g, String.fromCharCode(13));
}

// Resolve one key-bar or keyboard press while the Ctrl toggle may be armed.
// Any send consumes the arm: a lone letter becomes its control byte, anything
// else goes through as typed text.
export function pressWithCtrlArmed(
  input: KeyPress,
  ctrlArmed: boolean
): { bytes: string; ctrlArmed: boolean } {
  if ('key' in input) return { bytes: keyBytes(input.key), ctrlArmed: false };
  if (ctrlArmed && /^[A-Za-z]$/.test(input.text)) {
    return { bytes: ctrlBytes(input.text), ctrlArmed: false };
  }
  return { bytes: typedTextBytes(input.text), ctrlArmed: false };
}
