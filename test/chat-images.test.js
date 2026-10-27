import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chatImages from '../electron/services/chatImages.cjs';

describe('chat composer images', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-chatimg-'));
    chatImages.__setDeps({ tmpdir: () => dir });
  });
  afterEach(() => {
    chatImages.__setDeps({ tmpdir: () => os.tmpdir() });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('names the file with the wpxen prefix and the real extension', async () => {
    const jpg = await chatImages.saveChatImage(
      's1',
      new Uint8Array([0xff, 0xd8]),
      'image/jpeg'
    );
    expect(path.basename(jpg)).toMatch(
      new RegExp(`^${chatImages.CHAT_IMAGE_PREFIX}.+\\.jpg$`)
    );
    expect(chatImages.CHAT_IMAGE_PREFIX.startsWith('wpxen')).toBe(true);
    const webp = await chatImages.saveChatImage('s1', new Uint8Array([1]), 'image/webp');
    expect(webp.endsWith('.webp')).toBe(true);
    expect(fs.readFileSync(jpg)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it('refuses a type it cannot attach', async () => {
    await expect(
      chatImages.saveChatImage('s1', new Uint8Array([1]), 'image/svg+xml')
    ).rejects.toThrow();
  });

  it("deletes a Session's images once it is gone, and only its own", async () => {
    const mine = await chatImages.saveChatImage('s1', new Uint8Array([1]), 'image/png');
    const other = await chatImages.saveChatImage('s2', new Uint8Array([1]), 'image/png');
    await chatImages.clearChatImages('s1');
    expect(fs.existsSync(mine)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    await chatImages.clearAllChatImages();
    expect(fs.existsSync(other)).toBe(false);
  });
});
