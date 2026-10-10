import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TERMINAL_PALETTE,
  UNICODE_ADDON_VERSION,
  XTERM_VERSION,
  buildTerminalHtml,
} from './terminalWebView';

const rootPackageJson = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../package.json'), 'utf8')
);

describe('terminal WebView document', () => {
  it('loads the same xterm and unicode versions as the desktop', () => {
    expect(XTERM_VERSION).toBe(rootPackageJson.dependencies['@xterm/xterm'].replace(/^\^/, ''));
    expect(UNICODE_ADDON_VERSION).toBe(
      rootPackageJson.dependencies['@xterm/addon-unicode11'].replace(/^\^/, '')
    );
    const html = buildTerminalHtml({ theme: 'dark' });
    expect(html).toContain(`@xterm/xterm@${XTERM_VERSION}`);
    expect(html).toContain(`@xterm/addon-unicode11@${UNICODE_ADDON_VERSION}`);
  });

  it('mirrors the desktop terminal config and palette', () => {
    const html = buildTerminalHtml({ theme: 'dark' });
    expect(html).toContain('scrollback: 5000');
    expect(html).toContain("activeVersion = '11'");
    expect(html).toContain(TERMINAL_PALETTE.dark.background);
    expect(html).toContain(TERMINAL_PALETTE.dark.green);
    const light = buildTerminalHtml({ theme: 'light' });
    expect(light).toContain(TERMINAL_PALETTE.light.background);
    // Both palettes embed so the document can switch appearance at runtime.
    expect(light).toContain(TERMINAL_PALETTE.dark.green);
  });

  it('speaks the ready/write/reset/theme contract and nothing else remote', () => {
    const html = buildTerminalHtml({ theme: 'dark' });
    for (const type of ['init', 'write', 'reset', 'theme', 'grid', 'font-size', 'ready']) {
      expect(html).toContain(type);
    }
    const remoteUrls = [...html.matchAll(/https?:\/\/([^/"'\s]+)/g)].map((m) => m[1]);
    for (const host of remoteUrls) {
      expect(host).toBe('cdn.jsdelivr.net');
    }
  });
});
