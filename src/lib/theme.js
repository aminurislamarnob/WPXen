// Single source of truth for the colors that can't be expressed as Tailwind
// classes — xterm.js and CodeMirror both want plain hex strings at runtime.
// Keep these in sync with the CSS tokens in src/index.css: the dark palette is
// Superset's "ember", the light one its neutral theme, and in both the cursor /
// selection use WPHerd blue rather than Superset's ember orange.

// The 16-color ANSI sets double as the syntax palettes for the code editor
// (see src/lib/editorTheme.js), exactly like Superset derives its editor theme
// from the terminal theme.
export const terminalThemes = {
  dark: {
    background: '#151110',
    foreground: '#eae8e6',
    cursor: '#0a84ff',
    cursorAccent: '#151110',
    selectionBackground: 'rgba(10,132,255,0.28)',
    black: '#151110',
    red: '#dc6b6b',
    green: '#7ec699',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#eae8e6',
    brightBlack: '#5c5856',
    brightRed: '#e88888',
    brightGreen: '#98d1a8',
    brightYellow: '#ecd08f',
    brightBlue: '#7ec0f5',
    brightMagenta: '#d494e6',
    brightCyan: '#73c7d3',
    brightWhite: '#ffffff',
  },
  light: {
    background: '#ffffff',
    foreground: '#000000',
    cursor: '#0a60ff',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(10,96,255,0.20)',
    black: '#2e3436',
    red: '#cc0000',
    green: '#4e9a06',
    yellow: '#c4a000',
    blue: '#3465a4',
    magenta: '#75507b',
    cyan: '#06989a',
    white: '#d3d7cf',
    brightBlack: '#555753',
    brightRed: '#ef2929',
    brightGreen: '#8ae234',
    brightYellow: '#fce94f',
    brightBlue: '#729fcf',
    brightMagenta: '#ad7fa8',
    brightCyan: '#34e2e2',
    brightWhite: '#eeeeec',
  },
};

// UI chrome the editor needs but the ANSI set doesn't cover.
export const uiColors = {
  dark: {
    background: '#151110',
    foreground: '#eae8e6',
    muted: '#a8a5a3',
    border: '#2a2827',
    activeLine: 'rgba(42,40,39,0.5)',
    card: '#201e1c',
    tertiary: '#1a1716',
    comment: '#a8a5a3',
    search: 'rgba(10,132,255,0.22)',
    searchActive: 'rgba(10,132,255,0.45)',
  },
  light: {
    background: '#ffffff',
    foreground: '#252525',
    muted: '#828282',
    border: '#e7e7e7',
    activeLine: 'rgba(236,236,236,0.5)',
    card: '#f7f7f7',
    tertiary: '#f0eeed',
    comment: '#555753',
    search: 'rgba(255,211,61,0.35)',
    searchActive: 'rgba(10,96,255,0.35)',
  },
};

// The mono stack used by the terminal and the editor. Mirrors
// tailwind.config.js `fontFamily.mono`; JetBrains Mono is picked up
// automatically if the user has it installed, otherwise this falls back to the
// system monospace.
export const MONO_STACK =
  '"JetBrains Mono", "JetBrainsMono Nerd Font", "MesloLGS NF", "SF Mono", ui-monospace, Menlo, Monaco, monospace';

const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)');

export const isDark = () => darkQuery().matches;

export const themeName = () => (isDark() ? 'dark' : 'light');

// Subscribe to macOS appearance flips. Returns an unsubscribe function, so it
// plugs straight into a useEffect cleanup (or useSyncExternalStore).
export function onThemeChange(handler) {
  const mq = darkQuery();
  const listener = () => handler(mq.matches ? 'dark' : 'light');
  mq.addEventListener('change', listener);
  return () => mq.removeEventListener('change', listener);
}
