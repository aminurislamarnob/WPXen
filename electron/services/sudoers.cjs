'use strict';

// WPXen no longer installs a sudoers rule (spec #201): the grant let any
// process running as an admin user drive `brew services` as root with no
// password. What remains is detection and removal — DNS migration deletes
// every path below in its one privileged step (see dnsmasq.cjs), and
// `uninstall()` removes them on its own.

const { execSync } = require('child_process');
const fs = require('fs');
const { adminOsascript } = require('./admin.cjs');

const SUDOERS_PATH = '/etc/sudoers.d/wpxen';
// Pre-rename paths. Their rules are still live sudo grants, so removal clears
// them in the same privileged step rather than leaving a stray NOPASSWD file
// behind that the app no longer knows about.
const LEGACY_SUDOERS_PATHS = ['/etc/sudoers.d/wpdevpilot', '/etc/sudoers.d/wpherd'];
const MARKER = '# WPXen sudoers';

function isConfigured() {
  try {
    if (!fs.existsSync(SUDOERS_PATH)) return false;
    // The file is installed root-owned with mode 0440, so the Electron app
    // (running as a non-root user, typically not in the `wheel` group) usually
    // cannot read its contents. An EACCES/EPERM here means the file exists and
    // is correctly locked down — i.e. configured. Only a successful read that's
    // missing our marker means some other file is squatting the path.
    try {
      const content = fs.readFileSync(SUDOERS_PATH, 'utf8');
      return content.includes(MARKER);
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM') return true;
      throw err;
    }
  } catch {
    return false;
  }
}

// Every WPXen-generation sudoers file still on disk.
function presentPaths() {
  return [SUDOERS_PATH, ...LEGACY_SUDOERS_PATHS].filter((p) => fs.existsSync(p));
}

function uninstall() {
  const present = presentPaths();
  if (present.length === 0) return;
  const reason = 'WPXen wants to remove its passwordless permissions.';
  const targets = present.map((p) => `'${p}'`).join(' ');
  execSync(adminOsascript(`rm -f ${targets}`, reason), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

module.exports = {
  isConfigured,
  presentPaths,
  uninstall,
  SUDOERS_PATH,
  LEGACY_SUDOERS_PATHS,
};
