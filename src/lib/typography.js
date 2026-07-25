import { MONO_STACK } from './theme';

// Live typography for the terminal and the code editor.
//
// Both surfaces are created imperatively (xterm instances in the session cache,
// CodeMirror in CodeEditor) rather than re-rendered from props, so they read
// from this module and subscribe to changes instead of receiving settings down
// a tree. `SettingsProvider` pushes the resolved settings in via `apply()`
// whenever they load or change.

const DEFAULTS = {
  terminal: {
    fontFamily: '',
    fontSize: 13,
    lineHeight: 1.0,
    letterSpacing: 0,
    fontWeight: 400,
    ligatures: false,
    minimumContrast: 1,
    cursorStyle: 'block',
    cursorBlink: true,
  },
  editor: {
    fontFamily: '',
    fontSize: 13,
    lineHeight: 1.5,
    letterSpacing: 0,
    fontWeight: 400,
    ligatures: false,
  },
};

let current = { terminal: { ...DEFAULTS.terminal }, editor: { ...DEFAULTS.editor } };
const subscribers = new Set();

// A blank family means "use the built-in stack"; a custom one falls back to it
// so a typo'd or uninstalled font degrades instead of rendering in the UI sans.
function resolveFamily(family) {
  const name = (family || '').trim();
  return name ? `"${name.replace(/"/g, '')}", ${MONO_STACK}` : MONO_STACK;
}

function pick(settings, prefix, defaults) {
  const out = {};
  for (const key of Object.keys(defaults)) {
    const value = settings[`appearance.${prefix}.${key}`];
    out[key] = value === undefined ? defaults[key] : value;
  }
  return out;
}

/** Called by SettingsProvider with the flat settings map. */
export function apply(settings) {
  if (!settings) return;
  current = {
    terminal: pick(settings, 'terminal', DEFAULTS.terminal),
    editor: pick(settings, 'editor', DEFAULTS.editor),
  };
  for (const fn of subscribers) fn(current);
}

export function getTypography() {
  return current;
}

export function onTypographyChange(handler) {
  subscribers.add(handler);
  return () => subscribers.delete(handler);
}

/** xterm.js options derived from the terminal block. */
export function terminalOptions() {
  const t = current.terminal;
  return {
    fontFamily: resolveFamily(t.fontFamily),
    fontSize: t.fontSize,
    fontWeight: t.fontWeight,
    // xterm wants a separate bold weight; step up from the base without
    // exceeding the CSS maximum.
    fontWeightBold: Math.min(900, t.fontWeight + 300),
    lineHeight: t.lineHeight,
    letterSpacing: t.letterSpacing,
    cursorStyle: t.cursorStyle,
    cursorBlink: t.cursorBlink,
    minimumContrastRatio: t.minimumContrast,
  };
}

/** CodeMirror-facing values derived from the editor block. */
export function editorTypography() {
  const e = current.editor;
  return {
    fontFamily: resolveFamily(e.fontFamily),
    fontSize: `${e.fontSize}px`,
    lineHeight: String(e.lineHeight),
    letterSpacing: e.letterSpacing ? `${e.letterSpacing}px` : 'normal',
    fontWeight: String(e.fontWeight),
    fontVariantLigatures: e.ligatures ? 'normal' : 'none',
  };
}
