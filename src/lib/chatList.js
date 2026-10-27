import { defaultRangeExtractor } from '@tanstack/react-virtual';

// Returns the indices that should be rendered. Always includes the standard
// virtualised range, plus the very last item (to ensure smooth autoscrolling
// and measurement of the end), plus any specific `reveal` index if requested.
export function pinnedIndexes(range, { count, reveal }) {
  const indexes = new Set(defaultRangeExtractor(range));

  if (count > 0) {
    indexes.add(count - 1);
  }
  if (typeof reveal === 'number' && reveal >= 0 && reveal < count) {
    indexes.add(reveal);
  }

  return Array.from(indexes).sort((a, b) => a - b);
}

// Evaluates whether the scroll container should stick to the bottom.
// `threshold` is the distance in pixels from the bottom within which we
// consider the user to be "at the bottom".
export function shouldStickToBottom({
  scrollTop,
  scrollHeight,
  clientHeight,
  threshold = 48,
}) {
  if (clientHeight === 0 || scrollHeight === 0) return true;
  return scrollHeight - (scrollTop + clientHeight) <= threshold;
}

// After Load older, where the row the reader was looking at went: the index
// of the display item (a single row, or the folded run holding it) with the
// row `anchorId`. The virtualiser pins it via `reveal`, so the anchor stays
// rendered and measured while the older page lands above it. -1 if gone.
export function revealIndexAfterPrepend(folded, anchorId) {
  if (!anchorId) return -1;
  return folded.findIndex(
    (item) => item.id === anchorId || item.items?.some((row) => row.id === anchorId)
  );
}
