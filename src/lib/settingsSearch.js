import { SETTINGS_ITEMS } from './settingsRegistry';

// Settings search, ported from Superset's `getVisibleMatchCountBySection`.
//
// A query matches an item if every whitespace-separated term appears in its
// title, description or any keyword. All-terms-must-match (rather than any)
// keeps "php version" from surfacing every row that mentions PHP.

function haystack(item) {
  return `${item.title} ${item.description} ${item.keywords.join(' ')}`.toLowerCase();
}

function terms(query) {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export function matchesQuery(item, query) {
  const t = terms(query);
  if (t.length === 0) return true;
  const hay = haystack(item);
  return t.every((term) => hay.includes(term));
}

/** { [sectionId]: matchCount } for sections with at least one match. */
export function matchCountsBySection(query) {
  if (!terms(query).length) return null;
  const counts = {};
  for (const item of SETTINGS_ITEMS) {
    if (matchesQuery(item, query)) {
      counts[item.section] = (counts[item.section] || 0) + 1;
    }
  }
  return counts;
}

/**
 * Item ids a section should render for this query, or null for "no filter".
 * Sections pass this to `isItemVisible` per row.
 */
export function visibleItems(query) {
  if (!terms(query).length) return null;
  return SETTINGS_ITEMS.filter((item) => matchesQuery(item, query)).map((i) => i.id);
}

export function isItemVisible(id, visible) {
  return visible === null || visible === undefined || visible.includes(id);
}
