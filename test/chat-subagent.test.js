import { describe, it, expect } from 'vitest';
import { subagentExpansion } from '../src/lib/chatSubagent.js';

describe('subagentExpansion', () => {
  it('reports each change once', () => {
    const sent = [];
    const e = subagentExpansion((v) => sent.push(v));
    e.set(true);
    e.set(true);
    e.set(false);
    expect(sent).toEqual([true, false]);
  });

  it('reports closed when a row unmounts open, and only then', () => {
    const sent = [];
    const e = subagentExpansion((v) => sent.push(v));
    e.release();
    expect(sent).toEqual([]);
    e.set(true);
    e.release();
    e.release();
    expect(sent).toEqual([true, false]);
  });
});
