'use strict';

// electron-builder afterPack hook: everything the .app needs before it's
// wrapped into a DMG.
//
// 1. node-pty's spawn-helper gets its execute bit (see fix-pty-permissions).
// 2. The whole bundle gets an ad-hoc signature. Without a Developer ID,
//    electron-builder skips signing and the app ships with only Electron's
//    linker signature on the main binary and nothing sealing the rest. On
//    Apple Silicon a downloaded app in that state is reported as "damaged and
//    can't be opened", with no way past it short of `xattr`. Signed ad hoc, it
//    gets the ordinary unidentified-developer prompt and System Settings →
//    Privacy & Security → Open Anyway works. A real identity, when there is
//    one, re-signs over this in electron-builder's own signing step.

const { execFileSync } = require('child_process');
const path = require('path');
const fixPtyPermissions = require('./fix-pty-permissions.cjs');

async function afterPack(context) {
  await fixPtyPermissions(context);
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], {
    stdio: 'inherit',
  });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], {
    stdio: 'inherit',
  });
}

module.exports = afterPack;
module.exports.default = afterPack;
