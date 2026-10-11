import { describe, it, expect } from 'vitest';
import {
  matchFiles,
  matchCommands,
  recallStep,
  completionTrigger,
  applyCompletion,
  recallKey,
} from '../src/lib/chatComplete.js';

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

  describe('completion', () => {
    it('completes a command only at the start of the prompt', () => {
      expect(completionTrigger('/cl', 3)).toEqual({ type: 'cmd', query: 'cl', start: 1 });
      expect(completionTrigger('fix /src/a.js', 13)).toBeNull();
    });

    it('completes an @ file after whitespace anywhere', () => {
      expect(completionTrigger('look at @src/fo', 15)).toEqual({
        type: 'file',
        query: 'src/fo',
        start: 9,
      });
      expect(completionTrigger('mail me@example.com', 19)).toBeNull();
    });

    it('inserts a command without doubling its slash', () => {
      const t = completionTrigger('/cl', 3);
      expect(applyCompletion('/cl', t, '/clear')).toBe('/clear ');
    });

    it('inserts a file reference after the @', () => {
      const t = completionTrigger('look at @src/fo', 15);
      expect(applyCompletion('look at @src/fo', t, 'src/foo.js')).toBe(
        'look at @src/foo.js '
      );
    });
  });

  describe('recallKey', () => {
    it('recalls from an empty composer, not over a draft', () => {
      expect(recallKey({ key: 'ArrowUp', text: '', caret: 0, recalling: false })).toBe(
        true
      );
      expect(
        recallKey({ key: 'ArrowUp', text: 'draft', caret: 5, recalling: false })
      ).toBe(false);
    });

    it('keeps stepping while recalling, and leaves multi-line editing alone', () => {
      expect(recallKey({ key: 'ArrowUp', text: 'one', caret: 3, recalling: true })).toBe(
        true
      );
      expect(recallKey({ key: 'ArrowUp', text: 'a\nb', caret: 3, recalling: true })).toBe(
        false
      );
      expect(
        recallKey({ key: 'ArrowDown', text: 'a\nb', caret: 0, recalling: true })
      ).toBe(false);
      expect(
        recallKey({ key: 'ArrowDown', text: 'one', caret: 0, recalling: false })
      ).toBe(false);
    });

    it('steps back through several prompts', () => {
      const history = ['third', 'second', 'first'];
      let index = -1;
      const seen = [];
      for (let i = 0; i < 3; i++) {
        const step = recallStep(history, index, 1);
        index = step.index;
        seen.push(step.text);
      }
      expect(seen).toEqual(['third', 'second', 'first']);
    });
  });
});
