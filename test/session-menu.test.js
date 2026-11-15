import { describe, it, expect, vi } from 'vitest';
import { sessionMenuItems } from '../src/components/agents/sessionMenu.js';
import { applyListOptions } from '../src/lib/agentsList.js';

const labels = (items) => items.map((i) => (i === 'separator' ? '—' : i.label));

const act = () => ({
  toggleUnread: vi.fn(),
  togglePin: vi.fn(),
  rename: vi.fn(),
  handoff: vi.fn(),
  toggleView: vi.fn(),
  openInFinder: vi.fn(),
  openInEditor: vi.fn(),
  openInTerminal: vi.fn(),
  copy: vi.fn(),
  dismiss: vi.fn(),
  end: vi.fn(),
  isChatView: false,
});

const live = {
  sessionId: 's1',
  agentId: 'claude',
  isAgent: true,
  chat: 'claude',
  state: 'working',
  unread: false,
  pinned: false,
  displayTitle: 'storesuite',
  cwd: '/Users/me/storesuite',
  transcriptId: 'abc-123',
};

describe('sessionMenuItems', () => {
  it("follows Orca's row menu for a live agent Session", () => {
    expect(labels(sessionMenuItems(live, act()))).toEqual([
      'Mark Unread',
      'Pin',
      '—',
      'Rename…',
      'Hand Off to Another Agent…',
      'Switch to Chat View',
      '—',
      'Open in',
      'Copy',
      'Tab Color',
      '—',
      'End Session',
    ]);
  });

  it('flips the toggles to their undo, and offers Dismiss once ended', () => {
    const items = sessionMenuItems(
      { ...live, unread: true, pinned: true, state: 'exited' },
      { ...act(), isChatView: true }
    );
    expect(labels(items)).toContain('Mark Read');
    expect(labels(items)).toContain('Unpin');
    expect(labels(items)).toContain('Switch to Terminal View');
    expect(labels(items)).not.toContain('Hand Off to Another Agent…');
    expect(labels(items).at(-1)).toBe('Dismiss');
  });

  it('asks for a second click before ending a live Session', () => {
    const end = sessionMenuItems(live, act()).at(-1);
    expect(end).toMatchObject({ danger: true, confirm: expect.any(String) });
  });

  it('copies the name, path, transcript id and a resume command', () => {
    const a = act();
    const copy = sessionMenuItems(live, a).find((i) => i.label === 'Copy');
    expect(labels(copy.items)).toEqual(['Name', 'Path', 'Session ID', 'Resume Command']);
    copy.items.forEach((i) => i.onClick());
    expect(a.copy.mock.calls.map((c) => c[0])).toEqual([
      'storesuite',
      '/Users/me/storesuite',
      'abc-123',
      'claude --resume abc-123',
    ]);
  });

  it('leaves out what a plain shell has no use for', () => {
    const shell = {
      ...live,
      agentId: 'shell',
      isAgent: false,
      chat: null,
      transcriptId: null,
    };
    const items = sessionMenuItems(shell, act());
    expect(labels(items)).not.toContain('Hand Off to Another Agent…');
    expect(labels(items)).not.toContain('Switch to Chat View');
    expect(labels(items.find((i) => i.label === 'Copy').items)).toEqual(['Name', 'Path']);
  });
});

describe('Tab Color', () => {
  it('offers the palette with the current color selected', () => {
    const a = { ...act(), setColor: vi.fn() };
    const item = sessionMenuItems({ ...live, color: '#ef4444' }, a).find(
      (i) => i.label === 'Tab Color'
    );
    expect(item.value).toBe('#ef4444');
    expect(item.swatches[0]).toEqual({ label: 'None', value: null });
    item.onPick('#3b82f6');
    expect(a.setColor).toHaveBeenCalledWith('#3b82f6');
  });
});

describe('pinned Sessions', () => {
  it('lead their project under every sort', () => {
    const row = (id, extra) => ({
      sessionId: id,
      state: 'idle',
      changedAt: 0,
      children: [],
      ...extra,
    });
    const projects = [
      {
        site: { id: 'a', name: 'A' },
        sessions: [row('1'), row('2', { pinned: true }), row('3')],
      },
    ];
    for (const sessionSort of ['launch', 'attention']) {
      const [p] = applyListOptions(projects, { sessionSort });
      expect(p.sessions.map((s) => s.sessionId)[0]).toBe('2');
    }
  });
});
