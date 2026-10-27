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

const here = dirname(fileURLToPath(import.meta.url));
const rootPackageJson = JSON.parse(readFileSync(join(here, '../../../package.json'), 'utf8'));
const mobilePackageJson = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8'));

describe('terminal WebView document', () => {
  it('bundles the same xterm and unicode versions as the desktop', () => {
    expect(XTERM_VERSION).toBe(rootPackageJson.dependencies['@xterm/xterm'].replace(/^\^/, ''));
    expect(UNICODE_ADDON_VERSION).toBe(
      rootPackageJson.dependencies['@xterm/addon-unicode11'].replace(/^\^/, '')
    );
    // The versions bundled are the ones mobile/package.json pins.
    expect(mobilePackageJson.devDependencies['@xterm/xterm']).toBe(XTERM_VERSION);
    expect(mobilePackageJson.devDependencies['@xterm/addon-unicode11']).toBe(UNICODE_ADDON_VERSION);
    const html = buildTerminalHtml({ theme: 'dark' });
    expect(html).toContain('window.Terminal=');
    expect(html).toContain('.xterm');
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

  it('speaks the ready/write/reset/theme contract', () => {
    const html = buildTerminalHtml({ theme: 'dark' });
    for (const type of ['init', 'write', 'reset', 'theme', 'grid', 'font-size', 'ready']) {
      expect(html).toContain(type);
    }
  });

  // After Orca's terminal-webview-engine.test.ts. This page receives every
  // decrypted byte of terminal output, so nothing in it may come from, or
  // reach, the network.
  it('loads nothing remote: no URL, no script src, no stylesheet link', () => {
    for (const theme of ['dark', 'light'] as const) {
      const html = buildTerminalHtml({ theme });
      expect(html).not.toMatch(/\bhttps?:\/\//);
      expect(html).not.toContain('cdn.jsdelivr.net');
      expect(html).not.toContain('<script src=');
      expect(html).not.toMatch(/<link[^>]+stylesheet/);
      expect(html).toMatch(/Content-Security-Policy" content="default-src 'none';[^"]*connect-src 'none'/);
    }
  });
});
