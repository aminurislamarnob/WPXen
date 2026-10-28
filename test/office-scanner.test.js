import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  scan,
  emptyScanSnapshot,
  projectSlug,
  claudeHome,
  sessionsDir,
} from '../electron/services/office/scanner.cjs';
import { getProjectKey } from '../electron/services/office/projectKey.cjs';

// One-time port of claude-agent-verse packages/server/src/scanner.test.ts,
// plus the credentials guardrail the spec depends on (story #42). All fixture
// data is synthetic — invented paths, names and content only. The test seam is
// the CLAUDE_HOME override: scans run against a temp registry directory, and
// the test process's own pid stands in for a live Claude Code process.

describe('projectSlug', () => {
  it('turns every non-alphanumeric character into a dash, as Claude Code does', () => {
    expect(projectSlug('/Users/me/Herd/my.site/.claude/worktrees/a_b')).toBe(
      '-Users-me-Herd-my-site--claude-worktrees-a-b'
    );
  });
});

describe('scan', () => {
  let home;
  const entry = (status, statusUpdatedAt, sessionId = 's-1') =>
    // The test process itself is the "live" Claude Code pid.
    JSON.stringify({
      pid: process.pid,
      sessionId,
      cwd: home,
      name: 'demo',
      startedAt: 1,
      status,
      statusUpdatedAt,
    });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-office-'));
    fs.mkdirSync(path.join(home, 'sessions'));
    process.env.CLAUDE_HOME = home;
  });
  afterEach(() => {
    delete process.env.CLAUDE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('honors the CLAUDE_HOME override', () => {
    expect(claudeHome()).toBe(home);
    expect(sessionsDir()).toBe(path.join(home, 'sessions'));
  });

  it('reports the registry status with the session, then only when it changes', async () => {
    const file = path.join(home, 'sessions', `${process.pid}.json`);
    fs.writeFileSync(file, entry('busy', 100));
    const first = await scan(emptyScanSnapshot());
    expect(first.events.map((e) => e.type)).toEqual([
      'session_appeared',
      'session_status',
    ]);
    expect(first.events[1]).toMatchObject({ status: 'busy', at: 100, sessionId: 's-1' });

    const quiet = await scan(first.snapshot);
    expect(quiet.events).toEqual([]);

    fs.writeFileSync(file, entry('idle', 200, 's-2'));
    const changed = await scan(quiet.snapshot);
    expect(changed.events).toEqual([
      {
        type: 'session_status',
        pid: process.pid,
        status: 'idle',
        at: 200,
        sessionId: 's-2',
      },
    ]);
  });

  it('never reads key files beside the registry entries (credentials guardrail)', async () => {
    fs.writeFileSync(
      path.join(home, 'sessions', `${process.pid}.json`),
      entry('busy', 1)
    );
    // Neither a bare key file nor one disguised with a .json suffix is read.
    fs.writeFileSync(path.join(home, 'sessions', 'auth.key'), 'SECRET');
    fs.writeFileSync(
      path.join(home, 'sessions', 'auth.key.json'),
      JSON.stringify({ pid: process.pid, sessionId: 'leak', cwd: home })
    );
    const { events } = await scan(emptyScanSnapshot());
    const appeared = events.filter((e) => e.type === 'session_appeared');
    expect(appeared).toHaveLength(1);
    expect(appeared[0].sessionId).toBe('s-1');
  });

  it('skips dead pids and unparseable files', async () => {
    // macOS pids top out below 100000, so this one can never be alive.
    fs.writeFileSync(
      path.join(home, 'sessions', '999999.json'),
      JSON.stringify({ pid: 999999, sessionId: 'dead', cwd: home })
    );
    fs.writeFileSync(path.join(home, 'sessions', '17.json'), 'not json {');
    const { events, snapshot } = await scan(emptyScanSnapshot());
    expect(events).toEqual([]);
    expect(snapshot.sessions.size).toBe(0);
  });

  it('ends every known session when the registry directory disappears', async () => {
    fs.writeFileSync(
      path.join(home, 'sessions', `${process.pid}.json`),
      entry('busy', 1)
    );
    const first = await scan(emptyScanSnapshot());
    fs.rmSync(path.join(home, 'sessions'), { recursive: true, force: true });
    const gone = await scan(first.snapshot);
    expect(gone.events).toEqual([{ type: 'session_ended', pid: process.pid }]);
    expect(gone.snapshot.sessions.size).toBe(0);
  });

  it('ends a session whose process died between scans', async () => {
    const file = path.join(home, 'sessions', `${process.pid}.json`);
    fs.writeFileSync(file, entry('busy', 1));
    const first = await scan(emptyScanSnapshot());
    fs.rmSync(file);
    const gone = await scan(first.snapshot);
    expect(gone.events).toEqual([{ type: 'session_ended', pid: process.pid }]);
  });
});

describe('getProjectKey', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-projectkey-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the directory basename outside a git repo', async () => {
    const cwd = path.join(dir, 'acme-app');
    fs.mkdirSync(cwd);
    expect(await getProjectKey(cwd)).toBe('acme-app');
  });

  it('uses the repo root basename inside a git repo without a remote', async () => {
    const repo = path.join(dir, 'acme-repo');
    const nested = path.join(repo, 'packages', 'web');
    fs.mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    expect(await getProjectKey(nested)).toBe('acme-repo');
  });

  it('uses the origin remote name when one is set', async () => {
    const repo = path.join(dir, 'local-clone');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync(
      'git',
      ['remote', 'add', 'origin', 'https://example.test/acme/storefront.git'],
      { cwd: repo }
    );
    expect(await getProjectKey(repo)).toBe('storefront');
  });
});
