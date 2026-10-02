import { describe, it, expect } from 'vitest';
import {
  TOP_INSET,
  MIN_PANEL,
  TRIGGER_SIZE,
  DEFAULT_TRIGGER,
  isDrag,
  defaultPanelBounds,
  clampBounds,
  moveBounds,
  resizeBounds,
  maximizedBounds,
  triggerToPoint,
  pointToTrigger,
  parseBounds,
  parseTrigger,
} from '../src/lib/floatingGeometry';

const VP = { width: 1440, height: 900 };

describe('isDrag', () => {
  it('treats a movement under 4px as a click', () => {
    expect(isDrag(0, 0)).toBe(false);
    expect(isDrag(2, 3)).toBe(false); // 3.6px
    expect(isDrag(3, 3)).toBe(true); // 4.2px
    expect(isDrag(-4, 0)).toBe(true);
  });
});

describe('panel bounds', () => {
  it('opens at 920×560, anchored 24px from the right and 84px from the bottom', () => {
    expect(defaultPanelBounds(VP)).toEqual({
      x: 1440 - 24 - 920,
      y: 900 - 84 - 560,
      width: 920,
      height: 560,
    });
  });

  it('shrinks the default to fit a small window', () => {
    const b = defaultPanelBounds({ width: 800, height: 500 });
    expect(b.width).toBe(800);
    expect(b.x).toBe(0);
    expect(b.y).toBeGreaterThanOrEqual(TOP_INSET);
    expect(b.y + b.height).toBeLessThanOrEqual(500);
  });

  it('keeps a panel inside the window and below the drag strip', () => {
    expect(clampBounds({ x: -50, y: 0, width: 600, height: 400 }, VP)).toEqual({
      x: 0,
      y: TOP_INSET,
      width: 600,
      height: 400,
    });
    expect(clampBounds({ x: 1300, y: 800, width: 600, height: 400 }, VP)).toEqual({
      x: 1440 - 600,
      y: 900 - 400,
      width: 600,
      height: 400,
    });
  });

  it('never goes below the minimum size', () => {
    expect(clampBounds({ x: 100, y: 100, width: 10, height: 10 }, VP)).toMatchObject(
      MIN_PANEL
    );
  });

  it('a saved panel larger than the window is fitted, not left hanging off', () => {
    const b = clampBounds({ x: 0, y: 0, width: 3000, height: 3000 }, VP);
    expect(b).toEqual({ x: 0, y: TOP_INSET, width: 1440, height: 900 - TOP_INSET });
  });

  it('moves by a drag delta, clamped', () => {
    const start = { x: 200, y: 200, width: 600, height: 400 };
    expect(moveBounds(start, 50, -20, VP)).toEqual({ ...start, x: 250, y: 180 });
    expect(moveBounds(start, -999, -999, VP)).toEqual({ ...start, x: 0, y: TOP_INSET });
  });
});

describe('resizeBounds', () => {
  const start = { x: 200, y: 200, width: 600, height: 400 };

  it('moves only the dragged edge', () => {
    expect(resizeBounds(start, 'e', 100, 0, VP)).toEqual({ ...start, width: 700 });
    expect(resizeBounds(start, 's', 0, 50, VP)).toEqual({ ...start, height: 450 });
    expect(resizeBounds(start, 'w', -100, 0, VP)).toEqual({
      ...start,
      x: 100,
      width: 700,
    });
    expect(resizeBounds(start, 'n', 0, -50, VP)).toEqual({
      ...start,
      y: 150,
      height: 450,
    });
  });

  it('resizes both axes from a corner', () => {
    expect(resizeBounds(start, 'nw', -20, -30, VP)).toEqual({
      x: 180,
      y: 170,
      width: 620,
      height: 430,
    });
  });

  it('stops at the minimum size without moving the opposite edge', () => {
    const b = resizeBounds(start, 'w', 500, 0, VP);
    expect(b.width).toBe(MIN_PANEL.width);
    expect(b.x + b.width).toBe(start.x + start.width);
    const h = resizeBounds(start, 'n', 0, 500, VP);
    expect(h.height).toBe(MIN_PANEL.height);
    expect(h.y + h.height).toBe(start.y + start.height);
  });

  it('stops at the window edges and the drag strip', () => {
    expect(resizeBounds(start, 'e', 5000, 0, VP).width).toBe(1440 - 200);
    expect(resizeBounds(start, 'n', 0, -5000, VP).y).toBe(TOP_INSET);
    expect(resizeBounds(start, 'w', -5000, 0, VP).x).toBe(0);
  });
});

describe('maximizedBounds', () => {
  it('fills the window minus a 12px margin, below the drag strip', () => {
    expect(maximizedBounds(VP)).toEqual({
      x: 12,
      y: TOP_INSET,
      width: 1440 - 24,
      height: 900 - TOP_INSET - 12,
    });
  });
});

describe('launcher position', () => {
  it('defaults to 24px from the right and 72px from the bottom', () => {
    expect(triggerToPoint(DEFAULT_TRIGGER, VP)).toEqual({
      x: 1440 - 24 - TRIGGER_SIZE,
      y: 900 - 72 - TRIGGER_SIZE,
    });
  });

  it('is stored relative to the nearest corner', () => {
    expect(pointToTrigger({ x: 100, y: 100 }, VP)).toEqual({
      corner: 'tl',
      dx: 100,
      dy: 100,
    });
    expect(pointToTrigger({ x: 1300, y: 800 }, VP)).toEqual({
      corner: 'br',
      dx: 1440 - 1300 - TRIGGER_SIZE,
      dy: 900 - 800 - TRIGGER_SIZE,
    });
  });

  it('keeps its distance to that corner when the window resizes', () => {
    const pos = pointToTrigger({ x: 1300, y: 800 }, VP);
    const bigger = { width: 1920, height: 1080 };
    expect(triggerToPoint(pos, bigger)).toEqual({ x: 1920 - 140, y: 1080 - 100 });
  });

  it('round-trips a point', () => {
    for (const p of [
      { x: 40, y: 60 },
      { x: 1200, y: 60 },
      { x: 40, y: 700 },
      { x: 1200, y: 700 },
    ]) {
      expect(triggerToPoint(pointToTrigger(p, VP), VP)).toEqual(p);
    }
  });

  it('stays on screen in a window too small for its saved offset', () => {
    const p = triggerToPoint({ corner: 'tl', dx: 2000, dy: 2000 }, VP);
    expect(p).toEqual({ x: 1440 - TRIGGER_SIZE, y: 900 - TRIGGER_SIZE });
  });

  it('is kept below the drag strip', () => {
    expect(pointToTrigger({ x: 100, y: 0 }, VP).dy).toBe(TOP_INSET);
  });
});

describe('stored values', () => {
  it('parses well-formed bounds and rejects anything else', () => {
    expect(parseBounds('{"x":1,"y":2,"width":3,"height":4}')).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
    for (const raw of [
      null,
      '',
      'nope',
      '{"x":1}',
      '{"x":"1","y":2,"width":3,"height":4}',
    ]) {
      expect(parseBounds(raw)).toBeNull();
    }
  });

  it('parses a well-formed launcher position and rejects anything else', () => {
    expect(parseTrigger('{"corner":"tl","dx":5,"dy":6}')).toEqual({
      corner: 'tl',
      dx: 5,
      dy: 6,
    });
    for (const raw of [
      null,
      '{"corner":"middle","dx":5,"dy":6}',
      '{"corner":"tl"}',
      '[]',
    ]) {
      expect(parseTrigger(raw)).toBeNull();
    }
  });
});
