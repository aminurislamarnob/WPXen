'use strict';

// node-pty starts every terminal through a small `spawn-helper` binary, and the
// macOS prebuilds in node-pty 1.1.0 ship it without the execute bit. npm keeps
// the mode it was packed with and electron-builder copies it as-is, so every
// Agents terminal died with "posix_spawnp failed." — in dev and in the .app.
//
// Runs twice: as `postinstall` (fixes node_modules for `npm run dev`) and as
// electron-builder's `afterPack` hook (fixes the copy inside the bundle, before
// it's signed, whatever state node_modules was in).

const fs = require('fs');
const path = require('path');

// Marks every spawn-helper under `root`/node_modules/node-pty executable.
// Returns how many it found.
function fixPtyPermissions(root) {
  const ptyDir = path.join(root, 'node_modules', 'node-pty');
  const candidates = [path.join(ptyDir, 'build', 'Release', 'spawn-helper')];
  const prebuilds = path.join(ptyDir, 'prebuilds');
  if (fs.existsSync(prebuilds)) {
    for (const entry of fs.readdirSync(prebuilds)) {
      if (entry.startsWith('darwin-')) {
        candidates.push(path.join(prebuilds, entry, 'spawn-helper'));
      }
    }
  }
  let fixed = 0;
  for (const helper of candidates) {
    if (fs.existsSync(helper)) {
      fs.chmodSync(helper, 0o755);
      fixed++;
    }
  }
  return fixed;
}

// electron-builder afterPack hook. node-pty is unpacked from the asar (native
// code can't load from inside it), so the helpers live in app.asar.unpacked.
// A mac build with none found would ship a broken terminal — fail it instead.
async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const unpacked = path.join(
    context.appOutDir,
    appName,
    'Contents',
    'Resources',
    'app.asar.unpacked'
  );
  if (fixPtyPermissions(unpacked) === 0) {
    throw new Error(`No node-pty spawn-helper found under ${unpacked}`);
  }
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.fixPtyPermissions = fixPtyPermissions;

if (require.main === module) {
  fixPtyPermissions(path.join(__dirname, '..'));
}
