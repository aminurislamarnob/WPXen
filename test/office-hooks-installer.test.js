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
// and the backup/.tmp/diff/write sequence. Everything runs against temp files
// through the deps/__setDeps seam: the real ~/.claude is never touched.

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

// ─── File-level install / uninstall / status ────────────────────────────────

describe('install / uninstall / status against temp files', () => {
  let tmp;
  let settingsPath;
  let userDataDir;
  let legacyPath;
  let binDir;

  // A PATH directory holding a fake executable `node`, for the install-time check.
  function makeFakeNode() {
    fs.writeFileSync(path.join(binDir, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-hooks-installer-'));
    settingsPath = path.join(tmp, 'claude', 'settings.json');
    legacyPath = path.join(tmp, '.claude.json');
    userDataDir = path.join(tmp, 'user data'); // spaces, like Application Support
    binDir = path.join(tmp, 'bin');
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

  it('install writes the forwarder, backs up, diffs, writes tagged entries; uninstall restores', () => {
    makeFakeNode();
    const original = {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'theirs.sh' }] }] },
      otherSetting: 1,
    };
    fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2) + '\n');

    const result = installer.install();
    expect(result.changed).toBe(true);

    // Forwarder copied into userData.
    const forwarderPath = path.join(userDataDir, WPXEN_FORWARDER_FILENAME);
    expect(fs.existsSync(forwarderPath)).toBe(true);
    expect(fs.readFileSync(forwarderPath, 'utf8')).toBe(
      fs.readFileSync(
        path.join(__dirname, '..', 'electron', 'services', 'office', 'forwarder.cjs'),
        'utf8'
      )
    );

    // Backup is the pre-install file; a .tmp was staged; the diff names our tag.
    expect(JSON.parse(fs.readFileSync(`${settingsPath}.bak`, 'utf8'))).toEqual(original);
    expect(fs.existsSync(`${settingsPath}.tmp`)).toBe(true);
    expect(result.diff).toContain(WPXEN_HOOK_TAG);

    // Final write: ours tagged and quoted (userData has spaces), theirs intact.
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.SessionStart[0]).toEqual(original.hooks.SessionStart[0]);
    expect(written.hooks.SessionStart[1].hooks[0].command).toBe(
      `node "${forwarderPath}" ${WPXEN_HOOK_TAG}`
    );
    expect(written.otherSetting).toBe(1);

    // Status flips with the tag.
    expect(installer.status().installed).toBe(true);

    // Uninstall restores the original settings deep-equal and drops the forwarder.
    const removed = installer.uninstall();
    expect(removed.changed).toBe(true);
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual(original);
    expect(fs.existsSync(forwarderPath)).toBe(false);
    expect(installer.status().installed).toBe(false);
  });

  it('install with no settings file starts from {} and does not write a backup', () => {
    makeFakeNode();
    const result = installer.install();
    expect(result.changed).toBe(true);
    expect(fs.existsSync(`${settingsPath}.bak`)).toBe(false);
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    for (const hookName of HOOK_TYPES) {
      expect(JSON.stringify(written.hooks[hookName])).toContain(WPXEN_HOOK_TAG);
    }
  });

  it('install fails with a clear hint when node is missing, touching nothing', () => {
    // No fake node in binDir.
    const original = { hooks: {} };
    fs.writeFileSync(settingsPath, JSON.stringify(original) + '\n');

    expect(() => installer.install()).toThrow(/node/i);
    expect(() => installer.install()).toThrow(/brew install node|nodejs\.org/i);
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual(original);
    expect(fs.existsSync(path.join(userDataDir, WPXEN_FORWARDER_FILENAME))).toBe(false);
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
    fs.writeFileSync(legacyPath, JSON.stringify(legacy, null, 2) + '\n');

    installer.install();

    const swept = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    expect(JSON.stringify(swept)).not.toContain(LEGACY_HOOK_TAGS[0]);
    // Only a sweep — never an install into the legacy file.
    expect(JSON.stringify(swept)).not.toContain(WPXEN_HOOK_TAG);
    expect(swept.hooks.PreToolUse).toEqual([{ type: 'command', command: 'theirs.sh' }]);
    expect(swept.numStartups).toBe(12);
    expect(fs.existsSync(`${legacyPath}.bak`)).toBe(true);
  });

  it('status reports not-installed on a missing or untagged settings file', () => {
    expect(installer.status()).toMatchObject({ installed: false });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { SessionStart: 'echo hi' } }) + '\n'
    );
    expect(installer.status().installed).toBe(false);
  });
});
