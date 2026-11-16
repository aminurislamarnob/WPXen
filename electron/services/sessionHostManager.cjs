'use strict';

// ── Session Host runtime staging & lifecycle (#231) ──────────────────────────
// Because WPXen is updated by dragging a new app over the old one, a running
// Session Host must not load files from inside the app bundle. At launch (when
// the setting is on) we copy the host script, agentStatus.cjs, node-pty and its
// spawn-helper into `<userData>/<WPXEN_SESSION_HOST_DIR>/<version>/` and spawn
// the detached host from there using Electron in Node mode
// (`ELECTRON_RUN_AS_NODE=1`), so no system Node is required.
//
// Electron-free at module scope (enforced by test/no-module-scope-electron.test.js).

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { createSessionHostClient } = require('./sessionHostClient.cjs');
const { historyDir } = require('./sessionHistory.cjs');

// Naming law (CLAUDE.md "Legacy names"): everything written outside the app
// bundle carries the `wpxen` prefix via a named constant at the top of its
// module.
const WPXEN_SESSION_HOST_DIR = 'wpxen-session-host';
const WPXEN_SESSION_HOST_SOCKET_PREFIX = 'wpxen-host-';

function runtimeDirForVersion(userDataDir, version) {
  return path.join(userDataDir, WPXEN_SESSION_HOST_DIR, String(version));
}

function socketPathForVersion(userDataDir, version) {
  return path.join(userDataDir, `${WPXEN_SESSION_HOST_SOCKET_PREFIX}${version}.sock`);
}

function copyTreeJs(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyTreeJs(srcPath, destPath);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      fs.writeFileSync(destPath, fs.readFileSync(srcPath));
    }
  }
}

function findNativeBinaryDir(ptyRoot) {
  const unpackedRoot = ptyRoot
    .replace('app.asar', 'app.asar.unpacked')
    .replace('node_modules.asar', 'node_modules.asar.unpacked');
  const platArch = `${process.platform}-${process.arch}`;
  const candidates = [
    path.join(unpackedRoot, 'build', 'Release'),
    path.join(ptyRoot, 'build', 'Release'),
    path.join(unpackedRoot, 'prebuilds', platArch),
    path.join(ptyRoot, 'prebuilds', platArch),
  ];
  for (const dir of candidates) {
    if (
      fs.existsSync(path.join(dir, 'pty.node')) &&
      fs.existsSync(path.join(dir, 'spawn-helper'))
    ) {
      return dir;
    }
  }
  throw new Error(`Could not locate node-pty native binaries under ${ptyRoot}`);
}

function stageRuntimeFiles({
  userDataDir,
  version,
  servicesDir = __dirname,
  nodePtyDir = null,
} = {}) {
  if (!userDataDir || !version) {
    throw new Error('userDataDir and version are required');
  }
  const ptyRoot = nodePtyDir || path.dirname(require.resolve('node-pty/package.json'));
  const nativeSrcDir = findNativeBinaryDir(ptyRoot);
  const versionDir = runtimeDirForVersion(userDataDir, version);
  fs.mkdirSync(versionDir, { recursive: true });

  // Copy host runtime scripts.
  for (const file of ['sessionHost.cjs', 'agentStatus.cjs', 'sessionHistory.cjs']) {
    const src = path.join(servicesDir, file);
    if (fs.existsSync(src)) {
      fs.writeFileSync(path.join(versionDir, file), fs.readFileSync(src));
    }
  }

  // Copy node-pty package.json, JS lib tree, and native pty.node + spawn-helper.
  const targetPtyRoot = path.join(versionDir, 'node_modules', 'node-pty');
  fs.mkdirSync(targetPtyRoot, { recursive: true });
  fs.writeFileSync(
    path.join(targetPtyRoot, 'package.json'),
    fs.readFileSync(path.join(ptyRoot, 'package.json'))
  );
  copyTreeJs(path.join(ptyRoot, 'lib'), path.join(targetPtyRoot, 'lib'));

  const targetReleaseDir = path.join(targetPtyRoot, 'build', 'Release');
  fs.mkdirSync(targetReleaseDir, { recursive: true });
  for (const binName of ['pty.node', 'spawn-helper']) {
    const dest = path.join(targetReleaseDir, binName);
    fs.writeFileSync(dest, fs.readFileSync(path.join(nativeSrcDir, binName)));
    fs.chmodSync(dest, 0o755);
  }

  return {
    versionDir,
    hostScriptPath: path.join(versionDir, 'sessionHost.cjs'),
    socketPath: socketPathForVersion(userDataDir, version),
  };
}

function spawnDetachedHost({
  versionDir,
  hostScriptPath,
  socketPath,
  version,
  historyDirPath = null,
  execPath = process.execPath,
  spawn = childProcess.spawn,
} = {}) {
  const args = [hostScriptPath, '--socket', socketPath, '--version', String(version)];
  if (historyDirPath) args.push('--history-dir', historyDirPath);
  const child = spawn(execPath, args, {
    cwd: versionDir,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
  });
  child?.unref?.();
  return { pid: child?.pid ?? null };
}

async function tryConnectClient(socketPath, createClient) {
  const client = createClient({ socketPath });
  try {
    const hello = await client.hello();
    return { client, hello };
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
}

async function connectOrStartHost({
  userDataDir,
  version,
  createClient = createSessionHostClient,
  stage = stageRuntimeFiles,
  spawnHost = spawnDetachedHost,
  connectTimeoutMs = 4000,
} = {}) {
  const socketPath = socketPathForVersion(userDataDir, version);
  const versionDir = runtimeDirForVersion(userDataDir, version);

  // 1. Reconnect to an already-running Session Host if its socket responds.
  if (fs.existsSync(socketPath)) {
    try {
      const { client, hello } = await tryConnectClient(socketPath, createClient);
      return { client, hello, spawned: false, socketPath, versionDir };
    } catch {
      // Stale socket — stage and spawn a fresh host below.
    }
  }

  // 2. Stage runtime files into userData and spawn detached host from there.
  const staged = stage({ userDataDir, version });
  spawnHost({
    versionDir: staged.versionDir,
    hostScriptPath: staged.hostScriptPath,
    socketPath: staged.socketPath,
    version,
    historyDirPath: historyDir(userDataDir),
  });

  const deadline = Date.now() + connectTimeoutMs;
  let lastErr = new Error('Timed out waiting for Session Host socket');
  while (Date.now() < deadline) {
    if (fs.existsSync(staged.socketPath)) {
      try {
        const { client, hello } = await tryConnectClient(staged.socketPath, createClient);
        return {
          client,
          hello,
          spawned: true,
          socketPath: staged.socketPath,
          versionDir: staged.versionDir,
        };
      } catch (err) {
        lastErr = err;
      }
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw lastErr;
}

module.exports = {
  WPXEN_SESSION_HOST_DIR,
  WPXEN_SESSION_HOST_SOCKET_PREFIX,
  runtimeDirForVersion,
  socketPathForVersion,
  stageRuntimeFiles,
  spawnDetachedHost,
  connectOrStartHost,
};
