// Images pasted into the chat composer, saved as temp files the Agent's TUI
// can attach by path (a paste frame carries the path, never the bytes).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Written outside the app bundle: a rename has to find this prefix.
const CHAT_IMAGE_PREFIX = 'wpxen-chat-image-';

// Raster types only, by the clipboard item's MIME type; anything else is
// refused rather than saved under a misleading extension.
const IMAGE_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

let deps = {
  writeFile: (p, data) => fs.promises.writeFile(p, data),
  unlink: (p) => fs.promises.unlink(p),
  tmpdir: () => os.tmpdir(),
  randomUUID: () => crypto.randomUUID(),
};

function __setDeps(next) {
  deps = { ...deps, ...next };
}

// sessionId -> Set of temp paths it saved
const saved = new Map();

async function saveChatImage(sessionId, bytes, mime = 'image/png') {
  const ext = IMAGE_EXTENSIONS[String(mime).toLowerCase()];
  if (!ext) throw new Error(`Not an image type the chat attaches: ${mime}`);
  const file = path.join(
    deps.tmpdir(),
    `${CHAT_IMAGE_PREFIX}${deps.randomUUID()}.${ext}`
  );
  await deps.writeFile(file, Buffer.from(bytes));
  if (!saved.has(sessionId)) saved.set(sessionId, new Set());
  saved.get(sessionId).add(file);
  return file;
}

// The Session is gone, so nothing will attach these any more. Not on chat
// close: switching to terminal view closes the chat, and the composer's
// draft still holds the paths.
async function clearChatImages(sessionId) {
  const files = saved.get(sessionId);
  saved.delete(sessionId);
  if (!files) return;
  await Promise.all([...files].map((f) => deps.unlink(f).catch(() => {})));
}

async function clearAllChatImages() {
  await Promise.all([...saved.keys()].map((id) => clearChatImages(id)));
}

module.exports = {
  __setDeps,
  CHAT_IMAGE_PREFIX,
  IMAGE_EXTENSIONS,
  saveChatImage,
  clearChatImages,
  clearAllChatImages,
};
