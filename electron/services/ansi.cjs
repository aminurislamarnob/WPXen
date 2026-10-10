const ESC = '\x1b';
// Matches CSI sequences
const ANSI_ESCAPE_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g');
// Matches OSC sequences
const OSC_SEQUENCE_PATTERN = new RegExp(`${ESC}\\][^\\x07]*(?:\\x07|${ESC}\\\\)`, 'g');
// Matches single-character escapes
const SINGLE_ESCAPE_PATTERN = new RegExp(`${ESC}(?:[@-Z\\\\-_]|[()*+\\-./][0-~]|c)`, 'g');

function stripUnsupportedControlCharacters(value) {
  let result = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    // Drop C0 control chars except tab (9), newline (10), carriage return (13); keep DEL (127) out.
    if (
      code <= 8 ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    ) {
      continue;
    }
    result += char;
  }
  return result;
}

/**
 * Strips ANSI/OSC escapes and single-character escapes.
 */
function stripAnsi(value) {
  if (typeof value !== 'string') return '';
  return stripUnsupportedControlCharacters(
    value
      .replace(OSC_SEQUENCE_PATTERN, '')
      .replace(ANSI_ESCAPE_PATTERN, '')
      .replace(SINGLE_ESCAPE_PATTERN, '')
  );
}

/**
 * Strips ANSI escapes and collapses `\r` overwrites, returning the last N non-blank lines.
 */
function snapshotBuffer(buffer, lines = 15) {
  const stripped = stripAnsi(buffer);

  const processedLines = [];
  const rawLines = stripped.split(/\r?\n/);

  for (const line of rawLines) {
    // Collapse \r overwrites: keep text after the last \r
    const parts = line.split('\r');
    const collapsed = parts[parts.length - 1].trim();
    if (collapsed.length > 0) {
      processedLines.push(collapsed);
    }
  }

  return processedLines.slice(-lines).join('\n');
}

module.exports = { stripAnsi, snapshotBuffer };
