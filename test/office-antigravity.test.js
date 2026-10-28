import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AG_LIVE_MS,
  emptyAgScanSnapshot,
  scanAntigravity,
  toolPathFromStep,
  workspaceDir,
} from '../electron/services/office/antigravity.cjs';
import { reduce, emptyOffice } from '../electron/services/office/reducer.cjs';

// The Antigravity adapter: brain-folder discovery across the three surfaces,
// the 30-minute liveness window, synthetic negative pids, and workspace
// inference from tool-call paths. Ported case-for-case from the source
// adapter's suite; the transcript fixture mirrors the shapes of real
// Antigravity steps (step_index/source/type/status/created_at/content/
// tool_calls) with synthetic content. ANTIGRAVITY_HOME is the test seam —
// the real ~/.gemini also holds OAuth credentials and is never touched.

// A synthetic conversation: prompt → explore → edit → test → done, with a
// CHECKPOINT step no reducer case knows (it must be skipped, never thrown on).
const FIXTURE_STEPS = [
  {
    step_index: 0,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: '2024-03-05T09:00:01.500Z',
    content:
      '<USER_REQUEST>\nWire a coupon banner into the checkout page\n</USER_REQUEST>',
  },
  {
    step_index: 1,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2024-03-05T09:00:02.500Z',
    thinking: 'Look at the project layout first.',
    tool_calls: [{ name: 'list_dir', args: { DirectoryPath: '/synthetic/shop' } }],
  },
  {
    step_index: 2,
    source: 'SYSTEM',
    type: 'GENERIC',
    status: 'DONE',
    created_at: '2024-03-05T09:00:03.500Z',
    content: 'src/ package.json',
  },
  {
    step_index: 3,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2024-03-05T09:00:04.500Z',
    tool_calls: [
      {
        name: 'replace_file_content',
        args: { TargetFile: '/synthetic/shop/src/checkout/Banner.tsx' },
      },
    ],
  },
  {
    step_index: 4,
    source: 'SYSTEM',
    type: 'GENERIC',
    status: 'DONE',
    created_at: '2024-03-05T09:00:05.500Z',
    content: 'Edited 1 file',
  },
  {
    step_index: 5,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2024-03-05T09:00:06.500Z',
    tool_calls: [
      { name: 'run_command', args: { CommandLine: 'npm test', Cwd: '/synthetic/shop' } },
    ],
  },
  {
    step_index: 6,
    source: 'SYSTEM',
    type: 'GENERIC',
    status: 'DONE',
    created_at: '2024-03-05T09:00:08.500Z',
    content: 'Tests passed',
  },
  {
    step_index: 7,
    source: 'SYSTEM',
    type: 'CHECKPOINT',
    status: 'DONE',
    created_at: '2024-03-05T09:00:08.600Z',
  },
  {
    step_index: 8,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2024-03-05T09:00:09.500Z',
    content: 'Added the coupon banner to checkout and the tests pass.',
  },
];
const FIXTURE = FIXTURE_STEPS.map((s) => JSON.stringify(s)).join('\n') + '\n';

describe('scanAntigravity', () => {
  let home;

  function conversation(root, id, lines = '') {
    const logs = path.join(home, root, 'brain', id, '.system_generated', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    const file = path.join(logs, 'transcript.jsonl');
    fs.writeFileSync(file, lines);
    return file;
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-office-agy-'));
    process.env.ANTIGRAVITY_HOME = home;
  });
  afterEach(() => {
    delete process.env.ANTIGRAVITY_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('finds conversations from every Antigravity surface and keeps their ids stable', async () => {
    conversation('antigravity', 'conv-app');
    conversation('antigravity-cli', 'conv-cli');
    // A brain folder without a transcript yet, and stray files beside it, are not conversations.
    fs.mkdirSync(path.join(home, 'antigravity-ide', 'brain', 'conv-empty'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(home, 'oauth_creds.json'), '{}');

    const first = await scanAntigravity(emptyAgScanSnapshot());
    const office = first.events.reduce(reduce, emptyOffice());
    const sessions = Object.values(office.sessions);
    expect(sessions.map((s) => [s.sessionId, s.agent, s.projectKey]).sort()).toEqual([
      ['conv-app', 'antigravity', 'antigravity'],
      ['conv-cli', 'antigravity', 'antigravity'],
    ]);
    expect(sessions.every((s) => s.pid < 0)).toBe(true);

    const again = await scanAntigravity(first.snapshot);
    expect(again.events).toEqual([]);
    expect([...again.snapshot.conversations.values()]).toEqual([
      ...first.snapshot.conversations.values(),
    ]);
  });

  it('leaves out conversations nobody has touched lately, and lets them go when they fall quiet', async () => {
    const old = conversation('antigravity', 'conv-old');
    const live = conversation('antigravity', 'conv-live');
    const past = new Date(Date.now() - AG_LIVE_MS - 60_000);
    fs.utimesSync(old, past, past);

    const first = await scanAntigravity(emptyAgScanSnapshot());
    let office = first.events.reduce(reduce, emptyOffice());
    expect(Object.values(office.sessions).map((s) => s.sessionId)).toEqual(['conv-live']);

    fs.utimesSync(live, past, past);
    const later = await scanAntigravity(first.snapshot);
    office = later.events.reduce(reduce, office);
    expect(office.sessions).toEqual({});
  });

  it('drives the agent from its transcript', async () => {
    conversation('antigravity', '7c1f0a52-3e9b-4d1a-9f60-2b8e5d4c1a90', FIXTURE);
    const { events } = await scanAntigravity(emptyAgScanSnapshot());
    const appeared = events[0];
    if (appeared?.type !== 'session_appeared')
      throw new Error('expected the conversation to appear');

    const office = [
      ...events,
      ...FIXTURE_STEPS.map((line) => ({
        type: 'transcript_line',
        pid: appeared.pid,
        line,
      })),
    ].reduce(reduce, emptyOffice());

    const s = office.sessions[appeared.pid];
    expect(s.title).toBe('Wire a coupon banner into the checkout page');
    expect(s.state).toBe('idle');
    expect(s.feed.some((e) => e.excerpt === 'Used tool: run_command')).toBe(true);
    // The CHECKPOINT step (unknown type) left no trace and threw nothing.
    expect(s.feed.some((e) => e.id === 'step-7')).toBe(false);
  });
});

describe('toolPathFromStep', () => {
  beforeEach(() => {
    process.env.ANTIGRAVITY_HOME = '/home/dev/.gemini';
  });
  afterEach(() => {
    delete process.env.ANTIGRAVITY_HOME;
  });

  const call = (args) => ({
    type: 'PLANNER_RESPONSE',
    tool_calls: [{ name: 'tool', args }],
  });

  it("prefers a command's working directory over the file it touches", () => {
    expect(
      toolPathFromStep(call({ CommandLine: 'pnpm test', Cwd: '/work/acme-app' }))
    ).toBe('/work/acme-app');
    expect(
      toolPathFromStep(
        call({ TargetFile: '/work/acme-app/src/theme.ts', Cwd: '/work/acme-app' })
      )
    ).toBe('/work/acme-app');
  });

  it('names the file the agent edits, as written', () => {
    expect(toolPathFromStep(call({ TargetFile: '/work/acme-app/src/theme.ts' }))).toBe(
      '/work/acme-app/src/theme.ts'
    );
  });

  it('reads arguments sent as a JSON string', () => {
    expect(
      toolPathFromStep(call(JSON.stringify({ DirectoryPath: '/work/acme-app' })))
    ).toBe('/work/acme-app');
  });

  it("ignores Antigravity's own brain folder, relative paths and steps without tools", () => {
    expect(
      toolPathFromStep(
        call({ TargetFile: '/home/dev/.gemini/antigravity/brain/abc/task.md' })
      )
    ).toBeUndefined();
    expect(toolPathFromStep(call({ TargetFile: 'src/theme.ts' }))).toBeUndefined();
    expect(
      toolPathFromStep({ type: 'USER_INPUT', content: '/work/acme-app' })
    ).toBeUndefined();
    expect(toolPathFromStep(null)).toBeUndefined();
  });
});

describe('workspaceDir', () => {
  let root;
  let app;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-office-ws-'));
    app = path.join(root, 'acme-app');
    fs.mkdirSync(path.join(app, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'acme.app'), { recursive: true });
    fs.writeFileSync(path.join(app, 'Makefile'), '');
    fs.writeFileSync(path.join(app, '.env'), '');
    fs.writeFileSync(path.join(app, 'src', 'theme.ts'), '');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps a folder, even one with a dot in its name', async () => {
    expect(await workspaceDir(app)).toBe(app);
    expect(await workspaceDir(path.join(root, 'acme.app'))).toBe(
      path.join(root, 'acme.app')
    );
  });

  it('uses the folder of a file, even one without an extension', async () => {
    expect(await workspaceDir(path.join(app, 'src', 'theme.ts'))).toBe(
      path.join(app, 'src')
    );
    expect(await workspaceDir(path.join(app, 'Makefile'))).toBe(app);
    expect(await workspaceDir(path.join(app, '.env'))).toBe(app);
  });

  it('uses the nearest existing folder for a file about to be written', async () => {
    expect(await workspaceDir(path.join(app, 'src', 'new.ts'))).toBe(
      path.join(app, 'src')
    );
    expect(await workspaceDir(path.join(app, 'src', 'theme', 'dark.ts'))).toBe(
      path.join(app, 'src')
    );
  });

  it('reads a path that is not on this machine by its name', async () => {
    const elsewhere = path.join('/', `wpxen-nowhere-${Date.now()}`, 'proj');
    expect(await workspaceDir(path.join(elsewhere, 'src', 'x.ts'))).toBe(
      path.join(elsewhere, 'src')
    );
    expect(await workspaceDir(elsewhere)).toBe(elsewhere);
  });
});
