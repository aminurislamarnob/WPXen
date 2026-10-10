// Phone key-bar byte mapping (desktop: src/lib/terminal/keys.js). Arrows are
// CSI, Ctrl+letter masks to 0x1f — the same bytes the desktop sends, so TUIs
// cannot tell phone input apart. Control codes are built with
// String.fromCharCode so this file carries no raw control bytes.

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
  | 'enter';

const BYTES: Record<KeyId, string> = {
  esc: ESC,
  tab: String.fromCharCode(9),
  'ctrl-c': String.fromCharCode(3),
  up: `${CSI}A`,
  down: `${CSI}B`,
  right: `${CSI}C`,
  left: `${CSI}D`,
  enter: String.fromCharCode(13),
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

// Resolve one key-bar or keyboard press while the Ctrl toggle may be armed.
// Any send consumes the arm: a lone letter becomes its control byte, anything
// else goes through as-is.
export function pressWithCtrlArmed(
  input: KeyPress,
  ctrlArmed: boolean
): { bytes: string; ctrlArmed: boolean } {
  if ('key' in input) return { bytes: keyBytes(input.key), ctrlArmed: false };
  if (ctrlArmed && /^[A-Za-z]$/.test(input.text)) {
    return { bytes: ctrlBytes(input.text), ctrlArmed: false };
  }
  return { bytes: input.text, ctrlArmed: false };
}
