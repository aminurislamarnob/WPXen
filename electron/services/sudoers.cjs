'use strict';

// WPXen no longer installs a sudoers rule (spec #201): the grant let any
// process running as an admin user drive `brew services` as root with no
// password. What remains is detection — legacy DNS start/stop still uses a
// grant while one exists (brew.cjs), and the DNS migration notice stays up
// while any file below is on disk. DNS migration deletes them all in its one
// privileged step (see dnsmasq.cjs).

const fs = require('fs');

const SUDOERS_PATH = '/etc/sudoers.d/wpxen';
// Pre-rename paths. Their rules are still live sudo grants, so removal clears
// them in the same privileged step rather than leaving a stray NOPASSWD file
// behind that the app no longer knows about.
const LEGACY_SUDOERS_PATHS = ['/etc/sudoers.d/wpdevpilot', '/etc/sudoers.d/wpherd'];
// Every file any app generation installed, newest first.
const ALL_SUDOERS_PATHS = [SUDOERS_PATH, ...LEGACY_SUDOERS_PATHS];
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
  return ALL_SUDOERS_PATHS.filter((p) => fs.existsSync(p));
}

module.exports = {
  isConfigured,
  presentPaths,
  SUDOERS_PATH,
  LEGACY_SUDOERS_PATHS,
  ALL_SUDOERS_PATHS,
};
