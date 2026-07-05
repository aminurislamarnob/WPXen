import { describe, it, expect } from 'vitest';
import xdebug from '../electron/services/xdebug.cjs';

describe('normalizeMode', () => {
  it('defaults to debug for empty/invalid input', () => {
    expect(xdebug.normalizeMode('')).toBe('debug');
    expect(xdebug.normalizeMode(undefined)).toBe('debug');
    expect(xdebug.normalizeMode('nonsense')).toBe('debug');
  });

  it('passes through valid single and combined modes', () => {
    expect(xdebug.normalizeMode('develop')).toBe('develop');
    expect(xdebug.normalizeMode('debug,develop')).toBe('debug,develop');
  });

  it('trims, lowercases, dedupes, and drops unknown tokens', () => {
    expect(xdebug.normalizeMode(' Debug , develop , debug ')).toBe('debug,develop');
    expect(xdebug.normalizeMode('debug,bogus')).toBe('debug');
  });
});

describe('renderXdebugIni', () => {
  it('enabled: sets the mode and client connection directives', () => {
    const ini = xdebug.renderXdebugIni({ enabled: true, mode: 'debug,develop' });
    expect(ini).toMatch(/^xdebug\.mode = debug,develop$/m);
    expect(ini).toMatch(/^xdebug\.start_with_request = yes$/m);
    expect(ini).toMatch(/^xdebug\.client_host = localhost$/m);
    expect(ini).toMatch(/^xdebug\.client_port = 9003$/m);
    expect(ini).toMatch(/^; wpherd:enabled=1$/m);
    expect(ini).toMatch(/^; wpherd:mode=debug,develop$/m);
  });

  it('disabled: mode is off but the chosen mode is remembered in the marker', () => {
    const ini = xdebug.renderXdebugIni({ enabled: false, mode: 'develop' });
    expect(ini).toMatch(/^xdebug\.mode = off$/m);
    expect(ini).not.toMatch(/start_with_request/);
    expect(ini).toMatch(/^; wpherd:enabled=0$/m);
    expect(ini).toMatch(/^; wpherd:mode=develop$/m);
  });

  it('defaults mode to debug when none given', () => {
    expect(xdebug.renderXdebugIni({ enabled: true })).toMatch(/^xdebug\.mode = debug$/m);
  });
});

describe('parseXdebugIni round-trip', () => {
  it('reads back what renderXdebugIni wrote (enabled)', () => {
    const state = { enabled: true, mode: 'debug,develop' };
    expect(xdebug.parseXdebugIni(xdebug.renderXdebugIni(state))).toEqual(state);
  });

  it('reads back what renderXdebugIni wrote (disabled, remembering mode)', () => {
    const ini = xdebug.renderXdebugIni({ enabled: false, mode: 'develop' });
    expect(xdebug.parseXdebugIni(ini)).toEqual({ enabled: false, mode: 'develop' });
  });

  it('falls back to safe defaults for content without markers', () => {
    expect(xdebug.parseXdebugIni('xdebug.mode = debug')).toEqual({
      enabled: false,
      mode: 'debug',
    });
    expect(xdebug.parseXdebugIni('')).toEqual({ enabled: false, mode: 'debug' });
  });
});
