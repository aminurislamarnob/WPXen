'use strict';

// Builds an `osascript` command that runs `shellCmd` with administrator
// privileges, behind the macOS authentication dialog.
//
// `task` finishes one sentence, "WPXen needs administrator access to <task>.",
// so every prompt reads the same way: a short verb phrase, no explanation
// (e.g. 'stop the nginx service'). It is passed as AppleScript's `with
// prompt`. Older macOS shows it as the dialog's message; newer macOS (the
// "Allow administrator access for a script started by …" dialog) ignores it
// and shows only Apple's own text. The bold app name comes from the calling
// binary ("Electron" in dev, "WPXen" when packaged) and can't be changed
// without shipping a signed privileged helper.
//
// Because the dialog may say nothing about why, ask only when there is real
// work to do as root — never speculatively.
//
// Returns a shell command string suitable for execSync.
function adminPrompt(task) {
  return `WPXen needs administrator access to ${String(task || 'make changes').trim()}.`;
}

function adminOsascript(shellCmd, task) {
  const cmd = shellCmd.replace(/"/g, '\\"');
  // Escape backslashes and double quotes for the AppleScript string literal.
  const prompt = adminPrompt(task).replace(/["\\]/g, '\\$&');
  const appleScript = `do shell script "${cmd}" with prompt "${prompt}" with administrator privileges`;
  return `osascript -e '${appleScript.replace(/'/g, "'\\''")}'`;
}

module.exports = { adminOsascript, adminPrompt };
