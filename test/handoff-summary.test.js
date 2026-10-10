import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import {
  createSummaryTracker,
  SUMMARY_MARKER,
  SUMMARY_TIMEOUT_MS,
  SUBMIT_DELAY_MS,
} from '../electron/services/handoff.cjs';

describe('handoff summary tracker', () => {
  let status;
  let alive;
  let writes;
  let progress;
  let tracker;

  const agents = {
    getSession: (id) =>
      id === 's1' && alive ? { tracker: { snapshot: () => ({ state: status }) } } : null,
    write: (id, data) => writes.push({ id, data }),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    status = 'idle';
    alive = true;
    writes = [];
    progress = [];
    tracker = createSummaryTracker({
      sessionId: 's1',
      agents,
      onProgress: (p) => progress.push(p),
    });
  });

  afterEach(() => {
    tracker.cancel();
    fs.rmSync(tracker.filePath, { force: true });
    vi.useRealTimers();
  });

  const phase = () => progress.at(-1)?.phase;

  it('pastes the prompt into the source, then submits it as a separate write', () => {
    tracker.start();

    expect(writes).toHaveLength(1);
    const body = writes[0].data;
    expect(writes[0].id).toBe('s1');
    expect(body.startsWith('\x1b[200~')).toBe(true);
    expect(body.endsWith('\x1b[201~')).toBe(true);
    expect(body).toContain(tracker.filePath);
    expect(body).toContain(SUMMARY_MARKER);
    expect(body).not.toContain('\r');

    vi.advanceTimersByTime(SUBMIT_DELAY_MS);
    expect(writes[1].data).toBe('\r');
    expect(phase()).toBe('prompted');
  });

  it('does not count the idle status from before the prompt', () => {
    tracker.start();
    fs.writeFileSync(tracker.filePath, `notes\n${SUMMARY_MARKER}\n`);
    tracker.check();
    expect(tracker.state()).toBe('prompted');
  });

  it('needs the marker and idle/done together', () => {
    tracker.start();
    status = 'working';
    tracker.check();
    expect(tracker.state()).toBe('seen-working');

    // Marker, but the Agent is still working.
    fs.writeFileSync(tracker.filePath, `notes\n${SUMMARY_MARKER}\n`);
    tracker.check();
    expect(tracker.state()).toBe('seen-working');

    // Idle, but the file isn't finished.
    fs.writeFileSync(tracker.filePath, 'notes');
    status = 'idle';
    tracker.check();
    expect(tracker.state()).toBe('seen-working');

    // Marker that isn't the last line doesn't count either.
    fs.writeFileSync(tracker.filePath, `${SUMMARY_MARKER}\nmore notes`);
    tracker.check();
    expect(tracker.state()).toBe('seen-working');

    fs.writeFileSync(tracker.filePath, `notes\n${SUMMARY_MARKER}`);
    status = 'done';
    tracker.check();
    expect(tracker.state()).toBe('complete');
    expect(progress.at(-1)).toMatchObject({
      phase: 'complete',
      filePath: tracker.filePath,
    });
  });

  it('times out after five minutes', () => {
    tracker.start();
    vi.advanceTimersByTime(SUMMARY_TIMEOUT_MS - 1000);
    expect(tracker.state()).toBe('prompted');
    vi.advanceTimersByTime(1000);
    expect(phase()).toBe('timeout');
  });

  it('stops waiting when cancelled', () => {
    tracker.start();
    tracker.cancel();
    expect(phase()).toBe('cancelled');
    // A finished file afterwards changes nothing.
    status = 'working';
    tracker.check();
    expect(tracker.state()).toBe('cancelled');
  });

  it('gives up when the source Session is closed', () => {
    tracker.start();
    alive = false;
    tracker.check();
    expect(phase()).toBe('cancelled');
  });
});
