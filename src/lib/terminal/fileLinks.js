// Pure candidate-extraction for the terminal file-link provider. Kept separate
// from the xterm glue (fileLinkProvider.js) so it unit-tests in plain Node.

const MAX_LINE_LENGTH = 2000;
const MAX_LINKS_PER_LINE = 10;

// Path-ish token, optionally followed by :line:col. Deliberately simpler than
// VS Code's vendored parser:
//   group 1: a path with a slash (abs, ~/, or a/b/c), OR a bare name.ext word
//   group 2/3: optional :line and :col
// The leading class keeps the match from starting mid-word.
const CANDIDATE_RE =
  /(?:^|[\s"'`([])((?:~?\/)?[\w.-]+(?:\/[\w.-]+)+\/?|[\w-]+\.[A-Za-z]{1,8})(?::(\d+))?(?::(\d+))?/g;

// Extract candidate file references from one terminal line. Returns
// [{ text, start, end, line, col }] with 0-based [start, end) column offsets
// into the line. Validation against the filesystem happens in the provider.
export function extractFileCandidates(text) {
  if (!text || text.length > MAX_LINE_LENGTH) return [];
  const out = [];
  CANDIDATE_RE.lastIndex = 0;
  let m;
  while ((m = CANDIDATE_RE.exec(text)) !== null && out.length < MAX_LINKS_PER_LINE) {
    const pathText = m[1];
    if (!pathText) continue;
    // The match may include a leading delimiter char (group 0 vs group 1);
    // anchor start at where group 1 actually begins.
    const start = m.index + m[0].indexOf(pathText);
    const end = start + pathText.length;
    out.push({
      text: pathText,
      start,
      end,
      line: m[2] ? Number(m[2]) : undefined,
      col: m[3] ? Number(m[3]) : undefined,
    });
  }
  return out;
}
