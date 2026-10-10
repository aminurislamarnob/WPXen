import { describe, it, expect } from 'vitest';
import {
  tabsToClose,
  closeImpact,
  nextActive,
  needsBulkConfirm,
  paneIds,
} from '../src/lib/tabStrip';

describe('tabStrip', () => {
  const order = ['s1', 's2', 'f1', 'f2', 'b1'];

  describe('tabsToClose', () => {
    it('returns the correct tabs for close', () => {
      expect(tabsToClose(order, 'f1', 'close')).toEqual(['f1']);
    });

    it('returns the correct tabs for others', () => {
      expect(tabsToClose(order, 'f1', 'others')).toEqual(['s1', 's2', 'f2', 'b1']);
    });

    it('returns the correct tabs for left', () => {
      expect(tabsToClose(order, 'f1', 'left')).toEqual(['s1', 's2']);
    });

    it('returns the correct tabs for right', () => {
      expect(tabsToClose(order, 'f1', 'right')).toEqual(['f2', 'b1']);
    });

    it('returns empty array if key not found', () => {
      expect(tabsToClose(order, 'x', 'close')).toEqual([]);
    });
  });

  describe('closeImpact', () => {
    it('calculates running sessions and dirty files correctly', () => {
      const sessionsById = {
        s1: { exited: false },
        s2: { exited: true },
        f1: undefined,
      };
      const dirtyKeys = ['f1', 'f2'];

      expect(closeImpact(['s1', 's2', 'f1'], sessionsById, dirtyKeys)).toEqual({
        running: 1,
        dirty: ['f1'],
      });
    });

    it('counts split panes inside the layout tree', () => {
      const sessionsById = {
        s1: {
          exited: false,
          layout: { dir: 'right', a: { leaf: 's1' }, b: { leaf: 'p2' } },
        },
        p2: { exited: false },
        s2: {
          exited: false,
          layout: { dir: 'right', a: { leaf: 's2' }, b: { leaf: 'p3' } },
        },
        p3: { exited: true },
      };

      expect(closeImpact(['s1'], sessionsById, [])).toEqual({
        running: 2, // s1 and p2 are both running
        dirty: [],
      });

      expect(closeImpact(['s2'], sessionsById, [])).toEqual({
        running: 1, // s2 is running, p3 is exited
        dirty: [],
      });
    });
  });

  describe('nextActive', () => {
    it('returns null if all tabs are closed', () => {
      expect(nextActive(order, order, 's1')).toBeNull();
    });

    it('keeps activeKey if it is not closed', () => {
      expect(nextActive(order, ['s2'], 's1')).toBe('s1');
    });

    it('falls to the right if possible', () => {
      expect(nextActive(order, ['f1'], 'f1')).toBe('f2');
    });

    it('falls to the left if right is closed or at end', () => {
      expect(nextActive(order, ['b1'], 'b1')).toBe('f2');
      expect(nextActive(order, ['f1', 'f2', 'b1'], 'f1')).toBe('s2');
    });
  });

  describe('needsBulkConfirm', () => {
    it('asks when running Sessions would end, unless suppressed', () => {
      expect(needsBulkConfirm({ running: 2, dirty: [] }, false)).toBe(true);
      expect(needsBulkConfirm({ running: 2, dirty: [] }, true)).toBe(false);
    });

    it('closes silently when nothing is running or dirty', () => {
      expect(needsBulkConfirm({ running: 0, dirty: [] }, false)).toBe(false);
    });

    it('always asks for unsaved files, even when suppressed', () => {
      expect(needsBulkConfirm({ running: 0, dirty: ['f1'] }, true)).toBe(true);
    });
  });

  describe('paneIds', () => {
    it('is just the tab when it is not split', () => {
      expect(paneIds(null, 's1')).toEqual(['s1']);
    });

    it('lists every pane of a nested split', () => {
      const layout = {
        dir: 'right',
        a: { leaf: 's1' },
        b: { dir: 'down', a: { leaf: 'p1' }, b: { leaf: 'p2' } },
      };
      expect(paneIds(layout, 's1')).toEqual(['s1', 'p1', 'p2']);
    });
  });
});
