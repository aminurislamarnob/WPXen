import { describe, it, expect } from 'vitest';
import { mergeChatTitles, resolveChatTitle } from '../src/lib/chatTitle.js';

const prompt = (content) => ({ id: content, role: 'user', content });

describe('resolveChatTitle', () => {
  const session = { title: 'Claude Code', agentName: 'Claude Code' };

  it("ranks the user's rename over Claude's generated name", () => {
    expect(
      resolveChatTitle({
        titles: { custom: 'Mine', ai: 'Generated' },
        messages: [],
        session,
      })
    ).toBe('Mine');
  });

  it('uses the generated name over the first prompt', () => {
    expect(
      resolveChatTitle({
        titles: { ai: 'Generated' },
        messages: [prompt('hello')],
        session,
      })
    ).toBe('Generated');
  });

  it('falls back to the first real prompt before Claude names the chat', () => {
    const messages = [
      { id: 'a', role: 'assistant', content: 'hi' },
      prompt('  add a\nhealth   check '),
      prompt('second'),
    ];
    expect(resolveChatTitle({ titles: { agent: 'meta' }, messages, session })).toBe(
      'add a health check'
    );
  });

  it('then the agent name, then the terminal title, then the Agent', () => {
    expect(
      resolveChatTitle({ titles: { agent: 'reviewer' }, messages: [], session })
    ).toBe('reviewer');
    expect(resolveChatTitle({ titles: {}, messages: [], session })).toBe('Claude Code');
    expect(resolveChatTitle({ session: { agentName: 'Codex' } })).toBe('Codex');
    expect(resolveChatTitle()).toBe('');
  });
});

describe('mergeChatTitles', () => {
  it('keeps the same object when nothing changes', () => {
    const prev = { ai: 'Generated' };
    expect(mergeChatTitles(prev, { ai: 'Generated' })).toBe(prev);
    expect(mergeChatTitles(prev, undefined)).toBe(prev);
  });

  it('lets a later name of one kind replace that kind only', () => {
    const merged = mergeChatTitles({ custom: 'Mine', ai: 'Old' }, { ai: 'New' });
    expect(merged).toEqual({ custom: 'Mine', ai: 'New' });
  });
});
