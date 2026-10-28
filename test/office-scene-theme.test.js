import { describe, expect, it } from 'vitest';
import {
  hash,
  lookFor,
  palette,
  pick,
  stateColor,
  stateLabel,
  teamColor,
} from '../src/lib/office/scene/theme.js';

// The scene's own palette (ported from claude-agent-verse) — pixel-faithful,
// deliberately not WPXen tokens. These tests pin the derivations the 3D layer
// depends on; the geometry itself is reviewed through the dev Preview.

const ALL_STATES = ['working', 'thinking', 'waiting_on_user', 'idle', 'error', 'ended'];

describe('office scene theme', () => {
  it('has a colour and a label for all six Agent States', () => {
    for (const s of ALL_STATES) {
      expect(stateColor[s]).toMatch(/^#[0-9a-f]{6}$/);
      expect(stateLabel[s]).toBeTruthy();
    }
    // Waiting is the amber alert colour the paddle and tag share.
    expect(stateColor.waiting_on_user).toBe('#f59e0b');
    expect(stateLabel.waiting_on_user).toBe('Waiting on you');
  });

  it('keeps the ported art-direction anchors', () => {
    // Claude Code room accent and the warm-neutral floor from the source scene.
    expect(palette.accent).toBe('#d97757');
    expect(palette.floor).toBe('#d9c7ac');
  });

  it('hash is a deterministic unsigned 32-bit FNV-1a', () => {
    expect(hash('agent-verse')).toBe(hash('agent-verse'));
    expect(hash('a')).not.toBe(hash('b'));
    expect(hash('x')).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(hash('x'))).toBe(true);
  });

  it('pick is stable for a seed and varies with salt', () => {
    const list = ['a', 'b', 'c', 'd', 'e'];
    expect(pick(list, 42)).toBe(pick(list, 42));
    const salted = new Set([0, 1, 2, 3, 4].map((salt) => pick(list, 42, salt)));
    expect(salted.size).toBeGreaterThan(1);
  });

  it('teamColor is sticky per project key', () => {
    expect(teamColor('storefront')).toBe(teamColor('storefront'));
    expect(teamColor('storefront')).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('lookFor is deterministic and internally consistent', () => {
    const look = lookFor('session-1');
    expect(lookFor('session-1')).toEqual(look);
    // Traditional attire is all-or-nothing: thobe ⇔ prayer cap ⇔ beard.
    for (let i = 0; i < 50; i++) {
      const l = lookFor(`seed-${i}`);
      expect(l.attire === 'thobe').toBe(l.prayerCap);
      expect(l.prayerCap).toBe(l.beard);
      if (l.attire === 'thobe') expect(l.headphones).toBe(false);
      expect(l.beanie).toBe(false);
    }
  });

  it('interns always get a beanie and never traditional attire or headphones', () => {
    for (let i = 0; i < 50; i++) {
      const l = lookFor(`seed-${i}`, { intern: true });
      expect(l.beanie).toBe(true);
      expect(l.attire).toBe('hoodie');
      expect(l.headphones).toBe(false);
    }
  });

  it('some seeds produce the traditional look', () => {
    const any = Array.from({ length: 50 }, (_, i) => lookFor(`seed-${i}`)).some(
      (l) => l.attire === 'thobe'
    );
    expect(any).toBe(true);
  });
});
