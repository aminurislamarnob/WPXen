import { describe, it, expect } from 'vitest';
import { isEndedSession, canResumeSession } from '../src/lib/chatView.js';

// The exit bar gates on these: Respawn whenever the Session ended, Resume
// only once it has ended AND carries a pinned transcript for an Agent that
// can resume it. Two Sessions must never drive one conversation.

const ended = { exited: true, state: 'exited', transcriptId: 'uuid-1' };
const working = { exited: false, state: 'working', transcriptId: 'uuid-1' };
const claude = { id: 'claude', resumeFlag: '--resume' };
const plain = { id: 'shell' };

describe('isEndedSession', () => {
  it('ends on the exited flag even before the tracker flips', () => {
    expect(isEndedSession({ exited: true, state: 'working' })).toBe(true);
  });

  it('ends on the tracker state', () => {
    expect(isEndedSession({ exited: false, state: 'exited' })).toBe(true);
  });

  it('stays live while working', () => {
    expect(isEndedSession(working)).toBe(false);
  });

  it('stays live for a missing session', () => {
    expect(isEndedSession(null)).toBe(false);
    expect(isEndedSession(undefined)).toBe(false);
  });
});

describe('canResumeSession', () => {
  it('resumes an ended session with a transcript and a resume flag', () => {
    expect(canResumeSession(ended, claude)).toBe(true);
  });

  it('refuses while the old session is still running', () => {
    expect(canResumeSession(working, claude)).toBe(false);
  });

  it('refuses without a pinned transcript', () => {
    expect(canResumeSession({ ...ended, transcriptId: null }, claude)).toBe(false);
  });

  it('refuses when the agent cannot resume', () => {
    expect(canResumeSession(ended, plain)).toBe(false);
    expect(canResumeSession(ended, null)).toBe(false);
  });
});
