import { describe, it, expect } from 'vitest';
import {
  takeoverSteps,
  conflictMessage,
  BREW_NGINX_DAEMON,
  BREW_NGINX_AGENT,
} from '../electron/services/nginx.cjs';
import { adminPrompt, adminOsascript } from '../electron/services/admin.cjs';

// The admin prompt may show no reason at all on newer macOS, so WPXen must
// only ask when there is a root-owned Homebrew nginx to stop.
describe('nginx takeover', () => {
  const only =
    (...paths) =>
    (p) =>
      paths.includes(p);

  it('asks for nothing when no Homebrew nginx service exists (Herd, Valet, MAMP…)', () => {
    expect(takeoverSteps(only())).toEqual([]);
  });

  it('uses the admin prompt only for the old root LaunchDaemon', () => {
    expect(takeoverSteps(only(BREW_NGINX_DAEMON))).toEqual(['admin']);
    expect(takeoverSteps(only(BREW_NGINX_AGENT))).toEqual(['user']);
    expect(takeoverSteps(only(BREW_NGINX_DAEMON, BREW_NGINX_AGENT))).toEqual([
      'admin',
      'user',
    ]);
  });

  it('names Herd when Herd holds the ports', () => {
    expect(conflictMessage({ herd: true })).toMatch(/Laravel Herd .* Quit Herd/);
    expect(conflictMessage({ herd: false })).toMatch(/^Another nginx/);
  });
});

describe('admin prompt', () => {
  it('is one sentence for every task', () => {
    expect(adminPrompt('stop the nginx service')).toBe(
      'WPXen needs administrator access to stop the nginx service.'
    );
    expect(adminPrompt()).toBe('WPXen needs administrator access to make changes.');
  });

  it('escapes the task inside the AppleScript literal', () => {
    const cmd = adminOsascript('true', 'say "hi"');
    expect(cmd).toContain(
      'with prompt "WPXen needs administrator access to say \\"hi\\"."'
    );
  });
});
