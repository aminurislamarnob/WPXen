// Terminal WebView document: xterm.js running inside the phone's WebView,
// fed replay and live data over the RN bridge. It loads the same @xterm/xterm
// and Unicode 11 addon versions as the desktop (pinned below — keep them
// equal to the root package.json), and its palette is copied from the
// desktop terminalThemes in src/lib/theme.js (keep the hex in sync; the font
// stack is the phone's monospace rather than JetBrains Mono, which phones
// lack).
//
// Contract, after Orca's terminal-webview-messages edge cases (queue until
// ready, generation-guarded so a reconnect's reset drops stale queued
// writes):
//   RN → document: { type: 'init', theme, fontSize } | { type: 'write', data }
//     | { type: 'reset' } | { type: 'theme', theme } | { type: 'grid', cols, rows }
//     | { type: 'font-size', fontSize }
//   document → RN: { type: 'ready' }

export const XTERM_VERSION = '5.5.0';
export const UNICODE_ADDON_VERSION = '0.8.0';

const CDN = 'https://cdn.jsdelivr.net/npm';

export interface TerminalPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export const TERMINAL_PALETTE: { dark: TerminalPalette; light: TerminalPalette } = {
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

export const TERMINAL_FONT_STACK = 'ui-monospace, Menlo, monospace';
export const TERMINAL_FONT_SIZE = 13;
export const TERMINAL_SCROLLBACK = 5000;

export type TerminalThemeName = 'dark' | 'light';

export function buildTerminalHtml({ theme }: { theme: TerminalThemeName }): string {
  const palette = TERMINAL_PALETTE[theme];
  const xtermJs = `${CDN}/@xterm/xterm@${XTERM_VERSION}/lib/xterm.js`;
  const xtermCss = `${CDN}/@xterm/xterm@${XTERM_VERSION}/css/xterm.css`;
  const unicodeJs = `${CDN}/@xterm/addon-unicode11@${UNICODE_ADDON_VERSION}/lib/addon-unicode11.js`;
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">',
    `<link rel="stylesheet" href="${xtermCss}">`,
    '<style>',
    'html, body { margin: 0; padding: 0; height: 100%; background: ' + palette.background + '; }',
    '#terminal { height: 100%; padding: 8px; }',
    '</style>',
    '</head>',
    '<body>',
    '<div id="terminal"></div>',
    `<script src="${xtermJs}"></script>`,
    `<script src="${unicodeJs}"></script>`,
    '<script>',
    '(function () {',
    '  var term = null;',
    '  var generation = 0;',
    '  var pending = [];',
    '  var PALETTES = ' + JSON.stringify(TERMINAL_PALETTE) + ';',
    '  function post(type, extra) {',
    '    window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({ type: type }, extra)));',
    '  }',
    "  function currentTheme(name) { return name === 'light' ? PALETTES.light : PALETTES.dark; }",
    '  function handle(msg) {',
    "    if (msg.type === 'init') {",
    '      generation += 1;',
    '      if (term) { try { term.dispose(); } catch (e) {} }',
    '      term = new Terminal({',
    '        scrollback: ' + String(TERMINAL_SCROLLBACK) + ',',
    '        allowProposedApi: true,',
    '        disableStdin: true,',
    '        cursorBlink: true,',
    "        fontFamily: '" + TERMINAL_FONT_STACK + "',",
    '        fontSize: ' + String(TERMINAL_FONT_SIZE) + ',',
    '        theme: currentTheme(msg.theme),',
    '      });',
    '      term.loadAddon(new Unicode11Addon.Unicode11Addon());',
    "      term.unicode.activeVersion = '11';",
    "      term.open(document.getElementById('terminal'));",
    '      while (pending.length > 0) { handle(pending.shift()); }',
    "      post('ready', { generation: generation });",
    '      return;',
    '    }',
    '    if (!term) { pending.push(msg); return; }',
    "    if (msg.type === 'write') { term.write(msg.data); return; }",
    "    if (msg.type === 'reset') { generation += 1; pending = []; term.reset(); term.clear(); return; }",
    "    if (msg.type === 'theme') { term.options.theme = currentTheme(msg.theme); return; }",
    "    if (msg.type === 'grid') { try { term.resize(msg.cols, msg.rows); } catch (e) {} return; }",
    "    if (msg.type === 'font-size') { term.options.fontSize = msg.fontSize; return; }",
    '  }',
    '  document.addEventListener("message", function (event) { handle(JSON.parse(event.data)); });',
    '  window.addEventListener("message", function (event) { handle(JSON.parse(event.data)); });',
    '})();',
    '</script>',
    '</body>',
    '</html>',
  ].join('\n');
}
