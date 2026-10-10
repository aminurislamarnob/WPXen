import { describe, it, expect } from 'vitest';
import {
  isSelectAllChord,
  translateLineEditChord,
  shouldBubbleChord,
  trimSelection,
  isNonTextPaste,
  shellEscape,
  formatDropInput,
  isImageDropPath,
} from '../src/lib/terminal/keys.js';
import { Utf8Base64 } from '../src/lib/terminal/utf8Base64.js';

// Build a KeyboardEvent-shaped object; modifiers default to false.
const key = (over) => ({
  code: '',
  key: '',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe('isSelectAllChord', () => {
  it('matches Cmd+A', () => {
    expect(isSelectAllChord(key({ code: 'KeyA', metaKey: true }))).toBe(true);
  });
  it('rejects Ctrl+A', () => {
    expect(isSelectAllChord(key({ code: 'KeyA', ctrlKey: true }))).toBe(false);
  });
  it('rejects Cmd+Shift+A', () => {
    expect(isSelectAllChord(key({ code: 'KeyA', metaKey: true, shiftKey: true }))).toBe(
      false
    );
  });
  it('rejects Cmd+B', () => {
    expect(isSelectAllChord(key({ code: 'KeyB', metaKey: true }))).toBe(false);
  });
});

describe('translateLineEditChord', () => {
  it('Shift+Enter → ESC CR', () => {
    expect(translateLineEditChord(key({ key: 'Enter', shiftKey: true }))).toBe('\x1b\r');
  });
  it('Cmd+Enter → ESC CR', () => {
    expect(translateLineEditChord(key({ key: 'Enter', metaKey: true }))).toBe('\x1b\r');
  });
  it('Cmd+Backspace → ^U', () => {
    expect(translateLineEditChord(key({ key: 'Backspace', metaKey: true }))).toBe('\x15');
  });
  it('Cmd+Left → ^A', () => {
    expect(translateLineEditChord(key({ key: 'ArrowLeft', metaKey: true }))).toBe('\x01');
  });
  it('Cmd+Right → ^E', () => {
    expect(translateLineEditChord(key({ key: 'ArrowRight', metaKey: true }))).toBe(
      '\x05'
    );
  });
  it('Option+Left → ESC b', () => {
    expect(translateLineEditChord(key({ key: 'ArrowLeft', altKey: true }))).toBe('\x1bb');
  });
  it('Option+Right → ESC f', () => {
    expect(translateLineEditChord(key({ key: 'ArrowRight', altKey: true }))).toBe(
      '\x1bf'
    );
  });
  it('plain Enter → null', () => {
    expect(translateLineEditChord(key({ key: 'Enter' }))).toBeNull();
  });
  it('Cmd+Shift+Enter → null (not shift-only, not meta-only)', () => {
    expect(
      translateLineEditChord(key({ key: 'Enter', metaKey: true, shiftKey: true }))
    ).toBeNull();
  });
  it('Ctrl+Left → null (Windows chord not implemented on mac-only app)', () => {
    expect(translateLineEditChord(key({ key: 'ArrowLeft', ctrlKey: true }))).toBeNull();
  });
});

describe('shouldBubbleChord', () => {
  it('bubbles Cmd+C', () => {
    expect(shouldBubbleChord(key({ code: 'KeyC', metaKey: true }))).toBe(true);
  });
  it('does not bubble Ctrl+C', () => {
    expect(shouldBubbleChord(key({ code: 'KeyC', ctrlKey: true }))).toBe(false);
  });
  it('does not bubble a plain letter', () => {
    expect(shouldBubbleChord(key({ code: 'KeyX' }))).toBe(false);
  });
  it('bubbles Ctrl+Tab and Ctrl+Shift+Tab, for tab switching', () => {
    expect(shouldBubbleChord(key({ code: 'Tab', ctrlKey: true }))).toBe(true);
    expect(shouldBubbleChord(key({ code: 'Tab', ctrlKey: true, shiftKey: true }))).toBe(
      true
    );
  });
  it('bubbles Cmd+. so the chat view can interrupt the agent', () => {
    expect(shouldBubbleChord(key({ code: 'Period', key: '.', metaKey: true }))).toBe(
      true
    );
  });
  it('bubbles Cmd+Shift+C so the pane can toggle chat view', () => {
    expect(
      shouldBubbleChord(key({ code: 'KeyC', key: 'c', metaKey: true, shiftKey: true }))
    ).toBe(true);
  });
  it('does not bubble a plain Tab (completion)', () => {
    expect(shouldBubbleChord(key({ code: 'Tab' }))).toBe(false);
    expect(shouldBubbleChord(key({ code: 'Tab', shiftKey: true }))).toBe(false);
  });
});

describe('trimSelection', () => {
  it('strips trailing spaces and tabs per line', () => {
    expect(trimSelection('foo   \nbar\t\nbaz')).toBe('foo\nbar\nbaz');
  });
  it('preserves interior whitespace and blank lines', () => {
    expect(trimSelection('a  b  \n\n  c')).toBe('a  b\n\n  c');
  });
});

describe('isNonTextPaste', () => {
  const clip = (over) => ({
    clipboardData: {
      getData: (t) => (t === 'text/plain' ? (over.text ?? '') : ''),
      files: over.files ?? [],
    },
  });
  it('false when text present', () => {
    expect(isNonTextPaste(clip({ text: 'hello', files: [{}] }))).toBe(false);
  });
  it('false when no files', () => {
    expect(isNonTextPaste(clip({ text: '', files: [] }))).toBe(false);
  });
  it('true when files present and no text', () => {
    expect(isNonTextPaste(clip({ text: '', files: [{}] }))).toBe(true);
  });
  it('false when clipboardData is null', () => {
    expect(isNonTextPaste({ clipboardData: null })).toBe(false);
  });
});

describe('shellEscape', () => {
  it('quotes a plain path', () => {
    expect(shellEscape(['/Users/dev/Sites/my site'])).toBe("'/Users/dev/Sites/my site'");
  });
  it('escapes embedded single quotes', () => {
    expect(shellEscape(["it's.txt"])).toBe("'it'\\''s.txt'");
  });
  it('joins multiple paths with spaces', () => {
    expect(shellEscape(['a.txt', 'b.txt'])).toBe("'a.txt' 'b.txt'");
  });
  it('preserves unicode', () => {
    expect(shellEscape(['日本.txt'])).toBe("'日本.txt'");
  });
});

describe('isImageDropPath', () => {
  it('matches image extensions case-insensitively', () => {
    expect(isImageDropPath('/a/shot.PNG')).toBe(true);
    expect(isImageDropPath('/a/photo.jpeg')).toBe(true);
  });
  it('ignores dots in directory names', () => {
    expect(isImageDropPath('/home/jane.png/notes')).toBe(false);
    expect(isImageDropPath('/a/file.txt')).toBe(false);
  });
});

describe('formatDropInput', () => {
  const S = '\x1b[200~';
  const E = '\x1b[201~';
  const on = { bracketedPaste: true };

  it('bracketed-pastes a safe image path raw', () => {
    expect(formatDropInput(['/Users/me/Desktop/shot.png'], on)).toBe(
      `${S}/Users/me/Desktop/shot.png${E}`
    );
  });
  it('backslash-escapes an image path with spaces, never quotes it', () => {
    expect(formatDropInput(['/a/Screenshot 2026 (1).png'], on)).toBe(
      `${S}/a/Screenshot\\ 2026\\ \\(1\\).png${E}`
    );
  });
  it('types non-image paths shell-escaped with a trailing space', () => {
    expect(formatDropInput(['/a/my file.txt'], on)).toBe("'/a/my file.txt' ");
  });
  it('types images too when the program has no bracketed paste', () => {
    expect(formatDropInput(['/a/shot.png'])).toBe("'/a/shot.png' ");
  });
  it('keeps control-byte image paths as typed input', () => {
    expect(formatDropInput(['/a/b\nc.png'], on)).toBe("'/a/b\nc.png' ");
  });
  it('joins consecutive raw images without a space', () => {
    expect(formatDropInput(['/a/1.png', '/a/2.png'], on)).toBe(
      `${S}/a/1.png${E}${S}/a/2.png${E}`
    );
  });
  it('separates an image from a following non-image path', () => {
    expect(formatDropInput(['/a/1.png', '/a/b.txt'], on)).toBe(
      `${S}/a/1.png${E} '/a/b.txt' `
    );
  });
  it('separates an escaped image from the next image', () => {
    expect(formatDropInput(['/a/x y.png', '/a/2.png'], on)).toBe(
      `${S}/a/x\\ y.png${E} ${S}/a/2.png${E}`
    );
  });
});

describe('Utf8Base64', () => {
  const codec = new Utf8Base64();
  it('round-trips ASCII', () => {
    expect(codec.decodeText(codec.encodeText('hello world'))).toBe('hello world');
  });
  it('round-trips multi-byte characters', () => {
    expect(codec.decodeText(codec.encodeText('héllo 日本'))).toBe('héllo 日本');
  });
  it('throws on invalid UTF-8 bytes', () => {
    // 0xFF is never a valid standalone UTF-8 byte; base64 it directly.
    const badBase64 = btoa(String.fromCharCode(0xff));
    expect(() => codec.decodeText(badBase64)).toThrow();
  });
});
