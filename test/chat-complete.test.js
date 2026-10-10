import { describe, it, expect } from 'vitest';
import { matchFiles, matchCommands, recallStep } from '../src/lib/chatComplete.js';

describe('chatComplete', () => {
  describe('matchFiles', () => {
    it('does subsequence matching and ranks basename hits first', () => {
      const files = [
        'src/components/Button.jsx', // 25
        'vendor/a/b/button.php', // 21
        'src/lib/buttonUtils.js', // 22
        'not_basename/button_some.txt', // 28
      ];
      const matches = matchFiles('button', files);
      // All have basename hits. Sort by length then localeCompare.
      // vendor/a/b/button.php (21)
      // src/lib/buttonUtils.js (22)
      // src/components/Button.jsx (25)
      // not_basename/button_some.txt (28)
      expect(matches[0]).toBe('vendor/a/b/button.php');
      expect(matches[1]).toBe('src/lib/buttonUtils.js');
      expect(matches[2]).toBe('src/components/Button.jsx');
      expect(matches[3]).toBe('not_basename/button_some.txt');

      const sub = matchFiles('s/c/b', files);
      expect(sub[0]).toBe('src/components/Button.jsx');
    });
  });

  describe('matchCommands', () => {
    it('matches subsequence and ranks prefix hits first', () => {
      const commands = [
        { name: '/clear' },
        { name: '/my:clear:command' },
        { name: '/compact' },
      ];
      const matches = matchCommands('clear', commands);
      expect(matches[0].name).toBe('/clear');
      expect(matches[1].name).toBe('/my:clear:command');
    });
  });

  describe('recallStep', () => {
    it('steps through history', () => {
      const history = ['first', 'second', 'third'];
      expect(recallStep(history, -1, 1)).toEqual({ index: 0, text: 'first' });
      expect(recallStep(history, 0, 1)).toEqual({ index: 1, text: 'second' });
      expect(recallStep(history, 2, 1)).toEqual({ index: 2, text: 'third' });
      expect(recallStep(history, 1, -1)).toEqual({ index: 0, text: 'first' });
      expect(recallStep(history, 0, -1)).toEqual({ index: -1, text: null });
    });
  });
});
