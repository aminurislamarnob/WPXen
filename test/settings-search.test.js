import { describe, it, expect } from 'vitest';
import {
  matchesQuery,
  matchCountsBySection,
  visibleItems,
  isItemVisible,
} from '../src/lib/settingsSearch';
import { SETTINGS_ITEMS } from '../src/lib/settingsRegistry';

const item = {
  id: 'db.user',
  section: 'database',
  title: 'MySQL User',
  description: 'Used to create databases and configure WordPress',
  keywords: ['mysql', 'database', 'user', 'root', 'credentials'],
};

describe('matchesQuery', () => {
  it('matches on title, description and keywords', () => {
    expect(matchesQuery(item, 'MySQL')).toBe(true);
    expect(matchesQuery(item, 'configure')).toBe(true);
    expect(matchesQuery(item, 'credentials')).toBe(true);
  });

  it('is case and whitespace insensitive', () => {
    expect(matchesQuery(item, 'MYSQL')).toBe(true);
    expect(matchesQuery(item, '  mysql  ')).toBe(true);
  });

  it('requires every term to match, not just one', () => {
    expect(matchesQuery(item, 'mysql user')).toBe(true);
    expect(matchesQuery(item, 'mysql nginx')).toBe(false);
  });

  it('treats an empty query as matching everything', () => {
    expect(matchesQuery(item, '')).toBe(true);
    expect(matchesQuery(item, '   ')).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(matchesQuery(item, 'blueprint')).toBe(false);
  });
});

describe('matchCountsBySection', () => {
  it('returns null for an empty query so nothing is filtered', () => {
    expect(matchCountsBySection('')).toBeNull();
    expect(matchCountsBySection('  ')).toBeNull();
  });

  it('counts matches per section', () => {
    const counts = matchCountsBySection('mysql');
    expect(counts.database).toBe(2); // user + password
  });

  it('omits sections with no matches', () => {
    const counts = matchCountsBySection('mysql');
    expect(counts.blueprints).toBeUndefined();
  });

  it('returns an empty object when nothing matches', () => {
    expect(matchCountsBySection('zzzznotathing')).toEqual({});
  });
});

describe('visibleItems / isItemVisible', () => {
  it('returns null for an empty query and every row stays visible', () => {
    const visible = visibleItems('');
    expect(visible).toBeNull();
    expect(isItemVisible('db.user', visible)).toBe(true);
  });

  it('filters rows down to the matches', () => {
    const visible = visibleItems('blueprint');
    expect(visible).toContain('blueprints.list');
    expect(isItemVisible('db.user', visible)).toBe(false);
  });
});

describe('registry integrity', () => {
  it('has unique ids', () => {
    const ids = SETTINGS_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every row searchable keywords', () => {
    for (const entry of SETTINGS_ITEMS) {
      expect(entry.keywords.length, `${entry.id} has too few keywords`).toBeGreaterThan(
        3
      );
    }
  });
});
