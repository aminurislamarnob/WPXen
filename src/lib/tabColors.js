// The colors a Session tab can be marked with (tab menu → Tab Color), after
// Orca's TAB_COLORS (stablyai/orca, SortableTabContextMenu.tsx). Literal hex
// on purpose, like the status colors: a tab keeps its color in both
// appearances. `null` is None. The main process accepts only these values
// (TAB_COLOR_VALUES in electron/services/agents.cjs — keep the two in sync,
// asserted in test/agents-rename.test.js).
export const TAB_COLORS = [
  { label: 'None', value: null },
  { label: 'Blue', value: '#3b82f6' },
  { label: 'Purple', value: '#a855f7' },
  { label: 'Pink', value: '#ec4899' },
  { label: 'Red', value: '#ef4444' },
  { label: 'Orange', value: '#f97316' },
  { label: 'Yellow', value: '#eab308' },
  { label: 'Green', value: '#22c55e' },
  { label: 'Teal', value: '#14b8a6' },
  { label: 'Gray', value: '#9ca3af' },
];
