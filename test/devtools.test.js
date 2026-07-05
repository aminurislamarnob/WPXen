import { describe, it, expect } from 'vitest';
import devtools from '../electron/services/devtools.cjs';

describe('parseComposerVersion', () => {
  it('extracts the version from a --version line', () => {
    expect(
      devtools.parseComposerVersion('Composer version 2.7.1 2024-02-09 15:26:28')
    ).toBe('2.7.1');
  });

  it('handles the shorter "Composer 2.x" form', () => {
    expect(devtools.parseComposerVersion('Composer 2.6.6')).toBe('2.6.6');
  });

  it('keeps prerelease suffixes', () => {
    expect(devtools.parseComposerVersion('Composer version 2.8.0-RC1')).toBe('2.8.0-RC1');
  });

  it('returns null on unrecognized output', () => {
    expect(devtools.parseComposerVersion('command not found')).toBeNull();
    expect(devtools.parseComposerVersion('')).toBeNull();
  });
});

describe('sanitizeComposerArgs', () => {
  it('accepts whitelisted subcommands and appends --no-interaction', () => {
    expect(devtools.sanitizeComposerArgs(['install'])).toEqual([
      'install',
      '--no-interaction',
    ]);
    expect(devtools.sanitizeComposerArgs('update')).toEqual(['update', '--no-interaction']);
  });

  it('ignores extra args, only forwarding the whitelisted command', () => {
    expect(devtools.sanitizeComposerArgs(['install', '--dev', '; rm -rf /'])).toEqual([
      'install',
      '--no-interaction',
    ]);
  });

  it('rejects non-whitelisted commands', () => {
    expect(() => devtools.sanitizeComposerArgs(['exec'])).toThrow(/not allowed/);
    expect(() => devtools.sanitizeComposerArgs(['run-script'])).toThrow(/not allowed/);
    expect(() => devtools.sanitizeComposerArgs([])).toThrow(/not allowed/);
  });
});

describe('compareSemverDesc', () => {
  it('orders newest first', () => {
    const sorted = ['18.19.0', '20.11.0', '16.20.2'].sort(devtools.compareSemverDesc);
    expect(sorted).toEqual(['20.11.0', '18.19.0', '16.20.2']);
  });

  it('compares patch/minor correctly', () => {
    expect(devtools.compareSemverDesc('20.11.0', '20.9.0')).toBeLessThan(0);
    expect(devtools.compareSemverDesc('20.9.0', '20.11.0')).toBeGreaterThan(0);
    expect(devtools.compareSemverDesc('20.11.0', '20.11.0')).toBe(0);
  });
});

describe('parseNodeVersionDirs', () => {
  it('keeps only v-prefixed semver dirs, strips the v, sorts desc', () => {
    expect(
      devtools.parseNodeVersionDirs(['v20.11.0', 'v16.20.2', 'notaversion', '.DS_Store'])
    ).toEqual(['20.11.0', '16.20.2']);
  });

  it('returns empty for no matches or empty input', () => {
    expect(devtools.parseNodeVersionDirs([])).toEqual([]);
    expect(devtools.parseNodeVersionDirs(['lts', 'current'])).toEqual([]);
    expect(devtools.parseNodeVersionDirs(null)).toEqual([]);
  });
});
