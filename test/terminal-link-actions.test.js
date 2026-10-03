import { describe, it, expect } from 'vitest';
import { linkDestinations, resolveLinkClick } from '../src/lib/terminal/linkActions';

const click = (mods = {}) => ({
  metaKey: false,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
});

describe('terminal link clicks', () => {
  it('puts the Open links in setting first, the other second', () => {
    expect(linkDestinations('system')).toEqual({ primary: 'system', alternate: 'app' });
    expect(linkDestinations('app')).toEqual({ primary: 'app', alternate: 'system' });
    expect(linkDestinations(undefined)).toEqual({ primary: 'system', alternate: 'app' });
  });

  it('opens the card on a plain click', () => {
    expect(resolveLinkClick(click(), 'system')).toBe('actions');
  });

  it('⌘-click opens the default, ⇧⌘-click the other', () => {
    expect(resolveLinkClick(click({ metaKey: true }), 'system')).toBe('system');
    expect(resolveLinkClick(click({ metaKey: true, shiftKey: true }), 'system')).toBe(
      'app'
    );
    expect(resolveLinkClick(click({ metaKey: true }), 'app')).toBe('app');
    expect(resolveLinkClick(click({ metaKey: true, shiftKey: true }), 'app')).toBe(
      'system'
    );
  });

  it('leaves other chords to the terminal', () => {
    expect(resolveLinkClick(click({ ctrlKey: true }), 'system')).toBeNull();
    expect(resolveLinkClick(click({ altKey: true, metaKey: true }), 'system')).toBeNull();
    expect(resolveLinkClick(click({ shiftKey: true }), 'system')).toBeNull();
  });
});
