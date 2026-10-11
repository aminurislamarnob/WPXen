import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The renderer reaches the main process only through window.electronAPI
// (preload.cjs), which reaches it only through ipcMain handlers. A method or
// handler missing on either side fails at runtime, not at build time — so
// check both seams statically.
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(c?jsx?|mjs)$/.test(e.name)) out.push(rel);
  }
  return out;
}

const preload = read('electron/preload.cjs');
const exposeStart = preload.indexOf("exposeInMainWorld('electronAPI'");
const exposed = new Set(
  [...preload.slice(exposeStart).matchAll(/^ {2}(\w+):/gm)].map((m) => m[1])
);

describe('IPC surface', () => {
  it('exposes every window.electronAPI method the renderer calls', () => {
    const missing = [];
    for (const file of walk('src')) {
      // `\s*` spans line breaks: prettier often splits `electronAPI\n.foo(`.
      for (const m of read(file).matchAll(/electronAPI\s*\??\.\s*(\w+)/g)) {
        if (!exposed.has(m[1])) missing.push(`${file}: electronAPI.${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('has a main-process handler for every channel preload invokes', () => {
    const main = walk('electron').map(read).join('\n');
    const handled = new Set(
      [...main.matchAll(/ipcMain\.(?:handle|on|once)\(\s*'([^']+)'/g)].map((m) => m[1])
    );
    // Table-driven: for (const [channel, fn] of [['a', f], …]) ipcMain.handle(channel, …)
    for (const block of main.matchAll(
      /for \(const \[channel, \w+\] of \[([\s\S]*?)\]\) \{\s*ipcMain\.handle\(channel/g
    )) {
      for (const m of block[1].matchAll(/\[\s*'([^']+)'/g)) handled.add(m[1]);
    }
    const invoked = [
      ...preload.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*'([^']+)'/g),
    ].map((m) => m[1]);
    expect(invoked.filter((c) => !handled.has(c))).toEqual([]);
  });
});
