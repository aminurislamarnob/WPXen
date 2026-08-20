// How an agent's one-click installer describes itself in the UI.
//
// The two kinds are not equivalent and shouldn't read as if they were: `brew
// install` pulls a vetted package from a channel the app already depends on,
// while a script installer executes vendor code fetched over the network. The
// button looks the same, so the words carry the difference.
export function installerCommand(installer) {
  if (!installer) return '';
  if (installer.kind === 'brew') {
    return `brew install${installer.cask ? ' --cask' : ''} ${installer.name}`;
  }
  if (installer.kind === 'script') {
    return `curl -fsSL ${installer.url} | bash`;
  }
  return '';
}

// Subtitle for an undetected agent that can be installed.
export function installerSubtitle(installer) {
  if (!installer) return '';
  if (installer.kind === 'script') {
    return `Not installed — runs ${new URL(installer.url).host}’s install script`;
  }
  return `Not installed — ${installerCommand(installer)}`;
}

// Tooltip for the install control. The script variant spells out both what it
// runs and that it will touch the user's shell config, because neither is
// visible from a download icon.
export function installerTooltip(installer) {
  if (!installer) return '';
  if (installer.kind === 'script') {
    return `Run the vendor install script · ${installerCommand(installer)} · downloads and executes code from ${
      new URL(installer.url).host
    }, and may add a PATH line to your shell config`;
  }
  return `Install with Homebrew · ${installerCommand(installer)}`;
}
