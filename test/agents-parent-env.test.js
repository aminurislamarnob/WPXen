import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import agents from '../electron/services/agents.cjs';

// WPXen launched from inside a Claude Code session inherits that session's
// markers. Passed on to an Agent's pty, CLAUDE_CODE_CHILD_SESSION makes the
// child Claude turn transcript saving off, and the chat view stays empty.
const PARENT_ENV = {
  CLAUDECODE: '1',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_EXECPATH: '/somewhere/claude/versions/2.1.0',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/1.sock',
  CLAUDE_CODE_MESSAGING_TOKEN: 'token',
  CLAUDE_CODE_SESSION_ATTENDED: '1',
  CLAUDE_CODE_SESSION_ID: '00000000-0000-0000-0000-000000000000',
  CLAUDE_PID: '1',
};

let home;
let spawned;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-parent-env-'));
  spawned = [];
  agents.__setDeps({
    spawnPty: (file, args, opts) => {
      spawned.push(opts);
      return { onData() {}, onExit() {}, write: vi.fn(), resize: vi.fn(), kill: vi.fn() };
    },
    shellEnv: () => ({
      PATH: '/usr/bin',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CONFIG_DIR: '/custom/claude',
      ...PARENT_ENV,
    }),
    userShell: () => '/bin/zsh',
    homedir: () => home,
  });
});

afterEach(() => {
  agents.stopAll();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("a parent Claude session's environment", () => {
  it('lists every marker it strips', () => {
    expect([...agents.PARENT_AGENT_ENV_KEYS].sort()).toEqual(
      Object.keys(PARENT_ENV).sort()
    );
  });

  it('never reaches an Agent pty, while user Claude config does', () => {
    const site = { id: 'shop', name: 'Shop', path: home };
    const res = agents.launch({ site, agentId: agents.SHELL_ID });
    expect(res.error).toBeUndefined();
    expect(spawned).toHaveLength(1);
    const env = spawned[0].env;
    for (const key of Object.keys(PARENT_ENV)) expect(env).not.toHaveProperty(key);
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/custom/claude');
    expect(env.PATH).toContain('/usr/bin');
  });

  it('is stripped without mutating the cached shell env', () => {
    const source = { PATH: '/bin', ...PARENT_ENV };
    const out = agents.stripParentAgentEnv(source);
    expect(out).toEqual({ PATH: '/bin' });
    expect(source.CLAUDE_CODE_CHILD_SESSION).toBe('1');
  });
});
