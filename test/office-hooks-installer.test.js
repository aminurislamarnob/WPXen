import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import installer from '../electron/services/office/hooksInstaller.cjs';

// The Claude Code hook installer: a port of claude-agent-verse's hooks-cli
// (updateHooks + its six tests), retargeted at ~/.claude/settings.json — the
// file real tools (Orca, Agent Flow, Superset) register their hooks in on this
// machine — with the matcher-wrapper entry shape that file uses, a `# wpxen`
// tag, legacy `# claude-agent-verse` cleanup on both install and uninstall,
// and the preview → apply sequence (backup, atomic .tmp → rename). Everything
// runs against temp files through the deps/__setDeps seam: the real ~/.claude
// is never touched.

const {
  updateHooks,
  HOOK_TYPES,
  WPXEN_HOOK_TAG,
  LEGACY_HOOK_TAGS,
  WPXEN_FORWARDER_FILENAME,
} = installer;

const forwarderCommand = `node "/mock/user data/${WPXEN_FORWARDER_FILENAME}" ${WPXEN_HOOK_TAG}`;
// The entry install writes: the matcher-wrapper shape Claude Code reads from
// ~/.claude/settings.json (matcher omitted = match everything).
const newHookEntry = { hooks: [{ type: 'command', command: forwarderCommand }] };

describe('updateHooks (ported hooks-cli cases)', () => {
  describe('install', () => {
    it('adds entries for all forwarder events when hooks object is missing', () => {
      const settings = {};
      const { changed, nextSettings } = updateHooks(
        settings,
        'install',
        forwarderCommand
      );

      expect(changed).toBe(true);
      expect(nextSettings.hooks).toBeDefined();
      expect(HOOK_TYPES).toHaveLength(10);

      for (const hookName of HOOK_TYPES) {
        expect(nextSettings.hooks[hookName]).toEqual(newHookEntry);
      }
    });

    it('preserves pre-existing third-party hooks and adds ours', () => {
      const settings = {
        hooks: {
          PreToolUse: [{ type: 'command', command: 'block-dangerous-git.sh' }],
          SessionStart: 'echo welcome',
        },
      };

      const { changed, nextSettings } = updateHooks(
        settings,
        'install',
        forwarderCommand
      );

      expect(changed).toBe(true);
      expect(nextSettings.hooks.PreToolUse).toEqual([
        { type: 'command', command: 'block-dangerous-git.sh' },
        newHookEntry,
      ]);
      expect(nextSettings.hooks.SessionStart).toEqual(['echo welcome', newHookEntry]);

      // Other hooks should just have our entry
      expect(nextSettings.hooks.Notification).toEqual(newHookEntry);
    });

    it('is idempotent (running twice produces no duplicates)', () => {
      const settings = {};
      const first = updateHooks(settings, 'install', forwarderCommand);
      expect(first.changed).toBe(true);

      const second = updateHooks(first.nextSettings, 'install', forwarderCommand);
      expect(second.changed).toBe(false);
      expect(second.nextSettings).toEqual(first.nextSettings);

      for (const hookName of HOOK_TYPES) {
        expect(second.nextSettings.hooks[hookName]).toEqual(newHookEntry);
      }
    });
  });

  describe('uninstall', () => {
    it('removes exactly the tagged entries and leaves others intact', () => {
      const settings = {
        hooks: {
          PreToolUse: [
            { type: 'command', command: 'block-dangerous-git.sh' },
            newHookEntry,
            'another_hook',
          ],
          SessionStart: [newHookEntry],
          SessionEnd: 'echo bye', // untouched string
        },
        otherSetting: true,
      };

      const { changed, nextSettings } = updateHooks(
        settings,
        'uninstall',
        forwarderCommand
      );

      expect(changed).toBe(true);

      // Removed ours, kept others
      expect(nextSettings.hooks.PreToolUse).toEqual([
        { type: 'command', command: 'block-dangerous-git.sh' },
        'another_hook',
      ]);

      // SessionStart was only ours, so the key disappears
      expect(nextSettings.hooks.SessionStart).toBeUndefined();

      // SessionEnd had no tag, should remain a string, not an array
      expect(nextSettings.hooks.SessionEnd).toBe('echo bye');

      expect(nextSettings.otherSetting).toBe(true);
    });

    it('deletes the hooks object if it becomes empty', () => {
      const settings = {
        hooks: {
          PreToolUse: [newHookEntry],
          SessionStart: [newHookEntry],
        },
      };

      const { changed, nextSettings } = updateHooks(
        settings,
        'uninstall',
        forwarderCommand
      );

      expect(changed).toBe(true);
      expect(nextSettings.hooks).toBeUndefined();
    });

    it('does nothing if hooks are not present', () => {
      const settings = { other: 'value' };
      const { changed, nextSettings } = updateHooks(
        settings,
        'uninstall',
        forwarderCommand
      );

      expect(changed).toBe(false);
      expect(nextSettings).toEqual(settings);
    });
  });
});

describe('updateHooks legacy generation cleanup', () => {
  // The previous generation's entry, as claude-agent-verse's installer wrote it.
  const legacyEntry = {
    type: 'command',
    command: `tsx /old/path/forwarder.ts ${LEGACY_HOOK_TAGS[0]}`,
  };

  it('install strips legacy-tagged entries in the same edit', () => {
    const settings = {
      hooks: {
        PreToolUse: [{ type: 'command', command: 'third-party.sh' }, legacyEntry],
        SessionStart: [legacyEntry],
      },
    };

    const { changed, nextSettings } = updateHooks(settings, 'install', forwarderCommand);

    expect(changed).toBe(true);
    expect(JSON.stringify(nextSettings)).not.toContain(LEGACY_HOOK_TAGS[0]);
    expect(nextSettings.hooks.PreToolUse).toEqual([
      { type: 'command', command: 'third-party.sh' },
      newHookEntry,
    ]);
    // A key that held only the legacy entry now holds only ours.
    expect(nextSettings.hooks.SessionStart).toEqual([newHookEntry]);
  });

  it('uninstall strips legacy-tagged entries alongside ours', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { type: 'command', command: 'third-party.sh' },
          legacyEntry,
          newHookEntry,
        ],
      },
    };

    const { changed, nextSettings } = updateHooks(
      settings,
      'uninstall',
      forwarderCommand
    );

    expect(changed).toBe(true);
    expect(JSON.stringify(nextSettings)).not.toContain(LEGACY_HOOK_TAGS[0]);
    expect(JSON.stringify(nextSettings)).not.toContain(WPXEN_HOOK_TAG);
    expect(nextSettings.hooks.PreToolUse).toEqual([
      { type: 'command', command: 'third-party.sh' },
    ]);
  });
});

describe('updateHooks coexistence shape preservation', () => {
  // Synthetic entries copying the SHAPE of real tools' hooks in
  // ~/.claude/settings.json (matcher-wrapper, timeouts, long shell one-liners)
  // with invented content — per the fixture rule in CLAUDE.md.
  const orcaLike = {
    matcher: '*',
    hooks: [
      {
        type: 'command',
        command:
          'if [ -f "${HOME-}/.fake-orca/agent-hooks/claude-hook.sh" ]; then /bin/sh "${HOME-}/.fake-orca/agent-hooks/claude-hook.sh"; else printf \'{}\\n\'; fi',
        timeout: 10,
      },
    ],
  };
  const supersetLike = {
    matcher: '*',
    hooks: [
      {
        type: 'command',
        command:
          '[ -n "$FAKE_SUPERSET_HOME" ] && "$FAKE_SUPERSET_HOME/hooks/notify.sh" || true',
      },
    ],
  };
  const agentFlowLike = {
    hooks: [
      {
        type: 'command',
        command: '"/fake/nvm/versions/node/v24.0.0/bin/node" "/fake/agent-flow/hook.js"',
        timeout: 2,
      },
    ],
  };

  it('install → uninstall round-trips third-party entries byte-identical in shape', () => {
    const settings = {
      hooks: {
        SessionStart: [agentFlowLike, supersetLike, orcaLike],
        PermissionRequest: [supersetLike, orcaLike],
        PreToolUse: [orcaLike],
        TeammateIdle: [orcaLike], // a hook type WPXen does not install
      },
      otherSetting: { nested: true },
    };
    const original = JSON.parse(JSON.stringify(settings));

    const installed = updateHooks(settings, 'install', forwarderCommand);
    expect(installed.changed).toBe(true);
    // Third-party entries untouched by the install, ours appended after them.
    expect(installed.nextSettings.hooks.SessionStart.slice(0, 3)).toEqual(
      original.hooks.SessionStart
    );
    expect(installed.nextSettings.hooks.SessionStart[3]).toEqual(newHookEntry);
    expect(installed.nextSettings.hooks.TeammateIdle).toEqual(
      original.hooks.TeammateIdle
    );

    const removed = updateHooks(installed.nextSettings, 'uninstall', forwarderCommand);
    expect(removed.changed).toBe(true);
    expect(removed.nextSettings).toEqual(original);
  });
});

describe('updateHooks reinstall', () => {
  it('install replaces a stale tagged entry in place rather than adding a second', () => {
    // What an earlier build wrote: bare `node`, before node's path was pinned.
    const stale = {
      hooks: [{ type: 'command', command: `node "/old/fwd.cjs" ${WPXEN_HOOK_TAG}` }],
    };
    const theirs = { type: 'command', command: 'theirs.sh' };
    const settings = { hooks: { PreToolUse: [stale, theirs], Stop: stale } };

    const { changed, nextSettings } = updateHooks(settings, 'install', forwarderCommand);

    expect(changed).toBe(true);
    expect(nextSettings.hooks.PreToolUse).toEqual([newHookEntry, theirs]);
    // A bare value stays bare.
    expect(nextSettings.hooks.Stop).toEqual(newHookEntry);
  });

  it('install collapses duplicate tagged entries to one', () => {
    const settings = { hooks: { Stop: [newHookEntry, newHookEntry] } };
    const { changed, nextSettings } = updateHooks(settings, 'install', forwarderCommand);
    expect(changed).toBe(true);
    expect(nextSettings.hooks.Stop).toEqual([newHookEntry]);
  });
});

describe('forwarder command', () => {
  const { forwarderCommandFor, parseForwarderCommand } = installer;

  it('single-quotes both paths so spaces, $, ` and " stay literal', () => {
    const cmd = forwarderCommandFor('/opt/my node/bin/node', '/a "b" $HOME `x`/fwd.cjs');
    expect(cmd).toBe(
      `'/opt/my node/bin/node' '/a "b" $HOME \`x\`/fwd.cjs' ${WPXEN_HOOK_TAG}`
    );
    expect(parseForwarderCommand(cmd)).toEqual({
      nodePath: '/opt/my node/bin/node',
      forwarderPath: '/a "b" $HOME `x`/fwd.cjs',
    });
  });

  it('round-trips a path containing a single quote', () => {
    const cmd = forwarderCommandFor("/Users/o'brien/node", "/Users/o'brien/fwd.cjs");
    expect(cmd).toContain(`'/Users/o'\\''brien/node'`);
    expect(parseForwarderCommand(cmd)).toEqual({
      nodePath: "/Users/o'brien/node",
      forwarderPath: "/Users/o'brien/fwd.cjs",
    });
  });

  it('recognises the bare-node command an earlier build wrote', () => {
    expect(parseForwarderCommand(`node "/x/y z/fwd.cjs" ${WPXEN_HOOK_TAG}`)).toEqual({
      nodePath: null,
      forwarderPath: '/x/y z/fwd.cjs',
    });
    expect(parseForwarderCommand('something else # wpxen')).toBeNull();
  });
});

// ─── File-level preview / apply / status ────────────────────────────────────

describe('preview / apply / status against temp files', () => {
  let tmp;
  let settingsPath;
  let userDataDir;
  let legacyPath;
  let binDir;
  let nodeBin;
  let fwdPath;

  // A PATH directory holding a fake executable `node`, for the install-time check.
  function makeFakeNode() {
    fs.writeFileSync(nodeBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  const read = (p) => fs.readFileSync(p, 'utf8');
  const readJson = (p) => JSON.parse(read(p));
  const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-hooks-installer-'));
    settingsPath = path.join(tmp, 'claude', 'settings.json');
    legacyPath = path.join(tmp, '.claude.json');
    userDataDir = path.join(tmp, 'user data'); // spaces, like Application Support
    binDir = path.join(tmp, 'bin dir');
    nodeBin = path.join(binDir, 'node');
    fwdPath = path.join(userDataDir, WPXEN_FORWARDER_FILENAME);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    installer.__setDeps({
      settingsPath: () => settingsPath,
      legacySettingsPaths: () => [legacyPath],
      userDataPath: () => userDataDir,
      shellEnv: () => ({ PATH: binDir }),
    });
  });

  afterEach(() => {
    installer.__reset();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const original = {
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'theirs.sh' }] }] },
    otherSetting: 1,
  };

  it('preview computes the install diff and writes nothing', () => {
    makeFakeNode();
    writeJson(settingsPath, original);
    const before = read(settingsPath);

    const p = installer.preview('install');

    expect(p.changed).toBe(true);
    expect(p.diff).toContain(WPXEN_HOOK_TAG);
    // The command pins node's absolute path, resolved on the login-shell PATH.
    expect(p.diff).toContain(nodeBin);
    expect(p.nodeBin).toBe(nodeBin);
    expect(typeof p.token).toBe('string');
    // Nothing on disk moved: no write, no backup, no staging file, no forwarder.
    expect(read(settingsPath)).toBe(before);
    expect(fs.existsSync(`${settingsPath}.bak`)).toBe(false);
    expect(fs.existsSync(`${settingsPath}.tmp`)).toBe(false);
    expect(fs.existsSync(fwdPath)).toBe(false);
  });

  it('preview surfaces the legacy sweep diff without writing the legacy file', () => {
    makeFakeNode();
    writeJson(legacyPath, {
      hooks: { Stop: { type: 'command', command: `tsx /old.ts ${LEGACY_HOOK_TAGS[0]}` } },
      numStartups: 3,
    });
    const before = read(legacyPath);

    const p = installer.preview('install');

    expect(p.legacy).toHaveLength(1);
    expect(p.legacy[0]).toMatchObject({ path: legacyPath, changed: true });
    expect(p.legacy[0].diff).toContain(LEGACY_HOOK_TAGS[0]);
    expect(read(legacyPath)).toBe(before);
    expect(fs.existsSync(`${legacyPath}.bak`)).toBe(false);
  });

  it('apply install backs up, writes atomically, pins node, and copies the forwarder', () => {
    makeFakeNode();
    writeJson(settingsPath, original);
    fs.chmodSync(settingsPath, 0o600);
    const inodeBefore = fs.statSync(settingsPath).ino;

    const { token } = installer.preview('install');
    const result = installer.apply('install', { token });
    expect(result.changed).toBe(true);

    // Forwarder copied into userData.
    expect(read(fwdPath)).toBe(
      read(path.join(__dirname, '..', 'electron', 'services', 'office', 'forwarder.cjs'))
    );
    // Backup is the pre-install file.
    expect(readJson(`${settingsPath}.bak`)).toEqual(original);
    // Atomic: staged then renamed over — a new inode, no .tmp left behind,
    // and the original's permissions carried over.
    expect(fs.existsSync(`${settingsPath}.tmp`)).toBe(false);
    expect(fs.statSync(settingsPath).ino).not.toBe(inodeBefore);
    expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);

    const written = readJson(settingsPath);
    expect(written.hooks.SessionStart[0]).toEqual(original.hooks.SessionStart[0]);
    expect(written.hooks.SessionStart[1].hooks[0].command).toBe(
      installer.forwarderCommandFor(nodeBin, fwdPath)
    );
    expect(written.otherSetting).toBe(1);

    expect(installer.status()).toMatchObject({
      installed: true,
      healthy: true,
      problem: null,
      nodePath: nodeBin,
      forwarderPresent: true,
    });
  });

  it('apply writes through a symlinked settings file, keeping the link', () => {
    makeFakeNode();
    const real = path.join(tmp, 'dotfiles', 'settings.json');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    writeJson(real, original);
    fs.symlinkSync(real, settingsPath);

    installer.apply('install');

    expect(fs.lstatSync(settingsPath).isSymbolicLink()).toBe(true);
    expect(read(real)).toContain(WPXEN_HOOK_TAG);
  });

  it('apply refuses when the files changed since the preview, touching nothing', () => {
    makeFakeNode();
    writeJson(settingsPath, original);
    const { token } = installer.preview('install');

    const edited = { ...original, editedElsewhere: true };
    writeJson(settingsPath, edited);

    expect(() => installer.apply('install', { token })).toThrow(/changed since/i);
    expect(readJson(settingsPath)).toEqual(edited);
    expect(fs.existsSync(fwdPath)).toBe(false);
  });

  it('uninstall restores the original settings and drops the forwarder', () => {
    makeFakeNode();
    writeJson(settingsPath, original);
    installer.apply('install');

    const p = installer.preview('uninstall');
    expect(p.changed).toBe(true);
    expect(p.diff).toContain(WPXEN_HOOK_TAG);

    const removed = installer.apply('uninstall', { token: p.token });
    expect(removed.changed).toBe(true);
    expect(readJson(settingsPath)).toEqual(original);
    expect(fs.existsSync(fwdPath)).toBe(false);
    expect(fs.existsSync(`${settingsPath}.tmp`)).toBe(false);
    expect(installer.status()).toMatchObject({ installed: false, healthy: false });
  });

  it('install with no settings file starts from {} and does not write a backup', () => {
    makeFakeNode();
    const result = installer.apply('install');
    expect(result.changed).toBe(true);
    expect(fs.existsSync(`${settingsPath}.bak`)).toBe(false);
    const written = readJson(settingsPath);
    for (const hookName of HOOK_TYPES) {
      expect(JSON.stringify(written.hooks[hookName])).toContain(WPXEN_HOOK_TAG);
    }
  });

  it('install fails with a clear hint when node is missing, touching nothing', () => {
    // No fake node in binDir.
    const empty = { hooks: {} };
    writeJson(settingsPath, empty);

    expect(() => installer.preview('install')).toThrow(/brew install node|nodejs\.org/i);
    expect(() => installer.apply('install')).toThrow(/node/i);
    expect(readJson(settingsPath)).toEqual(empty);
    expect(fs.existsSync(fwdPath)).toBe(false);
  });

  it('install and uninstall sweep legacy entries out of the legacy settings file', () => {
    makeFakeNode();
    const legacy = {
      hooks: {
        PreToolUse: [
          { type: 'command', command: 'theirs.sh' },
          { type: 'command', command: `tsx /old/forwarder.ts ${LEGACY_HOOK_TAGS[0]}` },
        ],
      },
      numStartups: 12,
    };
    writeJson(legacyPath, legacy);

    installer.apply('install');

    const swept = readJson(legacyPath);
    expect(JSON.stringify(swept)).not.toContain(LEGACY_HOOK_TAGS[0]);
    // Only a sweep — never an install into the legacy file.
    expect(JSON.stringify(swept)).not.toContain(WPXEN_HOOK_TAG);
    expect(swept.hooks.PreToolUse).toEqual([{ type: 'command', command: 'theirs.sh' }]);
    expect(swept.numStartups).toBe(12);
    expect(fs.existsSync(`${legacyPath}.bak`)).toBe(true);
    expect(fs.existsSync(`${legacyPath}.tmp`)).toBe(false);
  });

  it('status reports not-installed on a missing or untagged settings file', () => {
    expect(installer.status()).toMatchObject({ installed: false, healthy: false });
    writeJson(settingsPath, { hooks: { SessionStart: 'echo hi' } });
    expect(installer.status().installed).toBe(false);
  });

  it('status flags a pinned node that no longer exists, and reinstalling fixes it', () => {
    makeFakeNode();
    installer.apply('install');
    fs.rmSync(nodeBin);

    expect(installer.status()).toMatchObject({
      installed: true,
      healthy: false,
      problem: { code: 'node-missing' },
      nodePath: nodeBin,
    });

    // node moved: the login shell now finds it elsewhere.
    const otherBin = path.join(tmp, 'other bin');
    fs.mkdirSync(otherBin);
    fs.writeFileSync(path.join(otherBin, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    installer.__setDeps({ shellEnv: () => ({ PATH: otherBin }) });

    installer.apply('install');
    expect(installer.status()).toMatchObject({
      healthy: true,
      nodePath: path.join(otherBin, 'node'),
    });
    // Replaced, not duplicated.
    const written = readJson(settingsPath);
    for (const hookName of HOOK_TYPES) {
      expect(JSON.stringify(written.hooks[hookName]).split(WPXEN_HOOK_TAG)).toHaveLength(
        2
      );
    }
  });

  it('status flags a missing forwarder, and reinstalling fixes it', () => {
    makeFakeNode();
    installer.apply('install');
    fs.rmSync(fwdPath);

    expect(installer.status()).toMatchObject({
      installed: true,
      healthy: false,
      forwarderPresent: false,
      problem: { code: 'forwarder-missing' },
    });

    // Settings already hold the right command: no diff, but apply still
    // restores the forwarder.
    expect(installer.preview('install').changed).toBe(false);
    installer.apply('install');
    expect(installer.status()).toMatchObject({ healthy: true, forwarderPresent: true });
  });

  it('recognises entries an earlier build wrote with bare node: flagged, replaced, removed', () => {
    makeFakeNode();
    fs.copyFileSync(
      path.join(__dirname, '..', 'electron', 'services', 'office', 'forwarder.cjs'),
      fwdPath
    );
    const bare = {
      hooks: [{ type: 'command', command: `node "${fwdPath}" ${WPXEN_HOOK_TAG}` }],
    };
    writeJson(settingsPath, {
      hooks: Object.fromEntries(HOOK_TYPES.map((h) => [h, [bare]])),
    });

    expect(installer.status()).toMatchObject({
      installed: true,
      healthy: false,
      problem: { code: 'node-unpinned' },
    });

    // Uninstall finds them by the tag.
    const p = installer.preview('uninstall');
    expect(p.changed).toBe(true);
    installer.apply('uninstall');
    expect(fs.existsSync(settingsPath) ? read(settingsPath) : '').not.toContain(
      WPXEN_HOOK_TAG
    );
  });

  it('reinstall over bare-node entries pins node in place', () => {
    makeFakeNode();
    const bare = {
      hooks: [{ type: 'command', command: `node "${fwdPath}" ${WPXEN_HOOK_TAG}` }],
    };
    writeJson(settingsPath, { hooks: { Stop: [bare] } });

    installer.apply('install');

    const written = readJson(settingsPath);
    expect(written.hooks.Stop).toEqual([
      {
        hooks: [
          { type: 'command', command: installer.forwarderCommandFor(nodeBin, fwdPath) },
        ],
      },
    ]);
    expect(installer.status().healthy).toBe(true);
  });

  it('preview and apply reject an unknown verb', () => {
    expect(() => installer.preview('nuke')).toThrow();
    expect(() => installer.apply('nuke')).toThrow();
  });
});
