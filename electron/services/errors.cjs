'use strict';

// Turns a raw error (often an execSync failure whose message embeds the entire
// shell command plus osascript/exit-code noise) into a short, plain-language
// message safe to show in the UI.
function humanize(err, fallback) {
  const raw = String(
    (err && ((err.stderr && err.stderr.toString()) || err.message)) || ''
  ).trim();

  const lower = raw.toLowerCase();

  // macOS admin/password dialog dismissed by the user.
  if (
    lower.includes('user canceled') ||
    lower.includes('user cancelled') ||
    raw.includes('(-128)')
  ) {
    return 'Cancelled — no changes were made.';
  }

  // Wrong password / authentication rejected by macOS.
  if (
    raw.includes('-60007') ||
    lower.includes('authentication') ||
    lower.includes('wrong password')
  ) {
    return 'Authentication failed. Please check your password and try again.';
  }

  // Filesystem / privilege denials.
  if (
    lower.includes('eacces') ||
    lower.includes('eperm') ||
    lower.includes('not permitted')
  ) {
    return 'Permission denied. Administrator rights are required for this action.';
  }

  if (lower.includes('homebrew is not installed')) {
    return 'Homebrew is not installed. Install it from https://brew.sh, then try again.';
  }

  if (
    lower.includes('visudo') ||
    lower.includes('rejected the syntax') ||
    lower.includes('sudoers file was not written')
  ) {
    return 'Could not set up permissions — the system rejected the change. Please try again.';
  }

  // AppleScript surfaces the real cause as "execution error: <msg>. (-N)".
  const m = raw.match(/execution error:\s*(.+?)\s*\(-?\d+\)/i);
  if (m) return m[1].trim().replace(/\.$/, '') + '.';

  // Last resort: strip execSync's "Command failed: <full command>" noise, then
  // return the first meaningful line that remains.
  const cleaned = raw.replace(/^Command failed:.*$/gm, '').trim();
  const firstLine = cleaned.split('\n').find((l) => l.trim());
  return firstLine
    ? firstLine.trim()
    : fallback || 'Something went wrong. Please try again.';
}

module.exports = { humanize };
