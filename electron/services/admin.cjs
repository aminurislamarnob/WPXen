'use strict';

// Builds an `osascript` command that runs `shellCmd` with administrator
// privileges. `reason` is shown in the macOS authentication dialog via
// AppleScript's `with prompt`, replacing the generic
// "osascript wants to make changes." body text with a plain-language
// explanation of what WPDevPilot is about to do.
//
// Note: the bold application name in the dialog ("osascript") is set by macOS
// from the calling binary and cannot be changed without shipping a signed
// privileged helper — only the message text is customizable here.
//
// Returns a shell command string suitable for execSync.
function adminOsascript(shellCmd, reason) {
  const cmd = shellCmd.replace(/"/g, '\\"');
  // Escape backslashes and double quotes for the AppleScript string literal.
  const prompt = String(reason || 'WPDevPilot wants to make changes.').replace(
    /["\\]/g,
    '\\$&'
  );
  const appleScript = `do shell script "${cmd}" with prompt "${prompt}" with administrator privileges`;
  return `osascript -e '${appleScript.replace(/'/g, "'\\''")}'`;
}

module.exports = { adminOsascript };
