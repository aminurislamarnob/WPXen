// OSC 8 hyperlinks: links a program prints as a label over a hidden target
// (`ESC]8;;<uri>ESC\label ESC]8;;ESC\`), the way Claude Code and other
// supports-hyperlinks CLIs render URLs and file paths in terminals that
// advertise them. WPXen advertises them (FORCE_HYPERLINK in the pty env), so
// every target reaching xterm's linkHandler is classified here first.
//
//   http(s): → { kind: 'web', uri }       — same handling as a plain URL click
//   file:    → { kind: 'file', path, line, col } — opens in the editor
//   anything else → null                   — not clickable
//
// Pure, so it unit-tests in plain Node.

// `#L12`, `#12`, `#L12:4`, `#12:4` — the fragment forms tools put on file links.
const LINE_FRAGMENT = /^#L?(\d+)(?::(\d+))?$/;

export function classifyHyperlink(uri) {
  if (typeof uri !== 'string' || uri.length > 4096) return null;
  let url;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === 'http:' || url.protocol === 'https:')
    return { kind: 'web', uri: url.href };
  if (url.protocol !== 'file:') return null;

  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (!path || path.includes('\0')) return null;
  const m = LINE_FRAGMENT.exec(url.hash);
  return {
    kind: 'file',
    path,
    line: m ? Number(m[1]) : undefined,
    col: m && m[2] ? Number(m[2]) : undefined,
  };
}
