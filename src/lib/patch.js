// A GitHub file patch (unified-diff hunks, no file headers) → the two sides
// the read-only diff view compares. GitHub only sends the hunks, so each side
// holds just the changed regions with their context; a marker line between
// hunks — identical on both sides, so never highlighted — shows where
// unchanged code was skipped.

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

export function hunkMarker(oldStart, newStart, context = '') {
  return `⋯ lines ${oldStart} → ${newStart}${context ? ` ·${context}` : ''}`;
}

export function patchToSides(patch) {
  const original = [];
  const modified = [];
  for (const line of String(patch || '').split('\n')) {
    const h = line.match(HUNK);
    if (h) {
      const marker = hunkMarker(h[1], h[2], h[3].trimEnd());
      original.push(marker);
      modified.push(marker);
    } else if (line.startsWith('+')) {
      modified.push(line.slice(1));
    } else if (line.startsWith('-')) {
      original.push(line.slice(1));
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — about the line above, not content.
    } else {
      const text = line.startsWith(' ') ? line.slice(1) : line;
      original.push(text);
      modified.push(text);
    }
  }
  return { original: original.join('\n'), modified: modified.join('\n') };
}
