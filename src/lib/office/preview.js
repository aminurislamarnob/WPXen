// ── Design preview ───────────────────────────────────────────
// A synthetic office that shows every Agent State at once, so the scene can be
// reviewed without live sessions. It feeds snapshots straight to the page and
// never touches the engine. Reached through the dev-only Preview menu on the
// Office page header (the source project used a `?preview` URL param; WPXen
// has no URL surface, and the menu is compiled out of packaged builds).

/** Ticks spent at work, then the same on break. */
const COMMUTE_TICKS = 6;

// The source cycled five states; WPXen adds `ended` so every one of the six
// Agent States can be reviewed from the Preview menu (ticket #182 AC).
export const STATES = [
  'working',
  'thinking',
  'waiting_on_user',
  'idle',
  'error',
  'ended',
];

// [project, title, state, tool?, interns?]
const claudeSeed = [
  ['agent-verse', 'Polish the office scene', 'working', 'Edit', ['working', 'thinking']],
  ['agent-verse', 'Reducer catch-up tests', 'thinking'],
  ['agent-verse', 'Hook installer diff', 'idle'],
  ['storefront', 'Checkout flow refactor', 'waiting_on_user'],
  ['storefront', 'Fix product grid CLS', 'working', 'Bash'],
  ['design-system', 'Token audit', 'idle'],
  ['design-system', 'Button variants', 'working', 'Write', ['working']],
  ['docs-site', 'Migrate to MDX', 'error'],
  ['wp-plugin', 'REST endpoint for orders', 'working', 'Read'],
  ['wp-plugin', 'PHPStan level 8', 'thinking'],
  ['ml-pipeline', 'Eval harness', 'idle'],
  ['mobile-app', 'Offline sync', 'waiting_on_user'],
];

const antigravitySeed = [
  ['storefront', 'Add a dark mode toggle', 'working', 'replace_file_content'],
  ['storefront', 'Audit checkout accessibility', 'thinking'],
  ['landing-page', 'Hero section animation', 'waiting_on_user'],
  ['landing-page', 'Lighthouse pass', 'idle'],
  ['data-api', 'Pagination for /orders', 'working', 'run_command'],
];

const ROOMS = [
  {
    agent: 'claude',
    pid: 1000,
    seed: claudeSeed,
    onBreak: new Set([2, 5, 10]),
    commuters: new Map([
      [4, 0],
      [8, 3],
    ]),
    tools: ['Edit', 'Bash', 'Read', 'Grep', 'WebFetch', 'Write'],
  },
  {
    agent: 'antigravity',
    pid: 2000,
    seed: antigravitySeed,
    onBreak: new Set([3]),
    commuters: new Map([[1, 2]]),
    tools: [
      'view_file',
      'run_command',
      'replace_file_content',
      'grep_search',
      'browser_subagent',
      'write_to_file',
    ],
  },
];

export function build(tick) {
  const sessions = {};
  for (const room of ROOMS) addRoom(sessions, room, tick);
  const waitingCount = Object.values(sessions).filter(
    (s) => s.state === 'waiting_on_user'
  ).length;
  return { sessions, waitingCount };
}

function addRoom(
  sessions,
  { agent, pid: firstPid, seed, onBreak: breaks, commuters, tools },
  tick
) {
  seed.forEach(([projectKey, title, base, tool, interns], i) => {
    const pid = firstPid + i;
    // A few desks cycle through states so the animations can be reviewed.
    const commute = commuters.get(i);
    const onBreak =
      breaks.has(i) ||
      (commute !== undefined && Math.floor((tick + commute) / COMMUTE_TICKS) % 2 === 1);
    const state = onBreak
      ? 'idle'
      : i % 4 === 1
        ? STATES[(tick + i) % STATES.length]
        : base;
    const subagents = {};
    (interns ?? []).forEach((s, k) => {
      const id = `intern-${i}-${k}`;
      subagents[id] = {
        subagentId: id,
        agentType: k ? 'Explore' : 'general-purpose',
        description: 'Survey call sites',
        toolUseId: id,
        state: s,
        currentTool: s === 'working' ? 'Grep' : undefined,
      };
    });
    sessions[pid] = {
      pid,
      agent,
      sessionId: agent === 'claude' ? `preview-${i}` : `preview-${agent}-${i}`,
      cwd: `~/code/${projectKey}`,
      name: `${projectKey}-${(i * 37).toString(16)}`,
      title,
      state,
      projectKey,
      startedAt: i,
      gitBranch: i % 3 ? 'main' : `feat/${title.toLowerCase().split(' ')[0]}`,
      currentTool:
        state === 'working' ? (tool ?? tools[(tick + i) % tools.length]) : undefined,
      lastPrompt: `${title} — keep the public API stable and add tests.`,
      feed: [
        { id: `${i}a`, role: 'user', type: 'text', excerpt: `${title}.` },
        {
          id: `${i}b`,
          role: 'assistant',
          type: 'tool_use',
          excerpt: `Read src/${projectKey}/index.ts`,
        },
        {
          id: `${i}c`,
          role: 'user',
          type: 'tool_result',
          excerpt: 'export function main() { … }',
        },
        {
          id: `${i}d`,
          role: 'assistant',
          type: 'text',
          excerpt: "I'll start by mapping the call sites, then update the tests.",
        },
        ...(state === 'error'
          ? [
              {
                id: `${i}e`,
                role: 'user',
                type: 'error',
                excerpt: 'Command failed: pnpm build (exit 1)',
              },
            ]
          : []),
      ],
      subagents,
      onBreak,
    };
  });
}

export const PREVIEW_INTERVAL_MS = 4000;

/**
 * Emits a synthetic office immediately, then (in `cycle` mode) a new tick every
 * few seconds so the cycling desks walk through every Agent State. `still`
 * freezes the first snapshot, which helps when reviewing one pose. Returns an
 * unsubscribe.
 *
 * @param {(office: object) => void} onOffice
 * @param {'cycle'|'still'} [mode]
 */
export function subscribePreview(onOffice, mode = 'cycle') {
  let tick = 0;
  onOffice(build(tick));
  if (mode === 'still') return () => {};
  const id = setInterval(() => onOffice(build(++tick)), PREVIEW_INTERVAL_MS);
  return () => clearInterval(id);
}
