import { describe, it, expect } from 'vitest';
import {
  buildGitignore,
  validateRemoteUrl,
  buildDeployEnv,
} from '../electron/services/gitdeploy.cjs';

describe('buildGitignore', () => {
  it('always excludes wp-config.php', () => {
    expect(buildGitignore()).toContain('wp-config.php');
    expect(buildGitignore({ includeUploads: true })).toContain('wp-config.php');
  });

  it('ignores uploads by default', () => {
    expect(buildGitignore()).toContain('wp-content/uploads/');
  });

  it('drops the uploads rule when includeUploads is on', () => {
    expect(buildGitignore({ includeUploads: true })).not.toContain('wp-content/uploads/');
  });

  it('excludes junk and cache dirs', () => {
    const ignore = buildGitignore();
    for (const rule of ['.DS_Store', '*.log', 'node_modules/', 'wp-content/cache/']) {
      expect(ignore).toContain(rule);
    }
  });
});

describe('validateRemoteUrl', () => {
  it.each([
    ['git@github.com:me/repo.git'],
    ['git@bitbucket.org:team/site'],
    ['ssh://git@github.com/me/repo.git'],
    ['https://github.com/me/repo.git'],
  ])('accepts %s', (url) => {
    expect(validateRemoteUrl(url)).toBe(true);
  });

  it.each([
    ['--upload-pack=/bin/sh'], // git argv-option injection
    ['-oProxyCommand=evil'],
    ['http://github.com/me/repo.git'], // plaintext http
    ['file:///etc'],
    ['git@github.com:me repo'], // whitespace
    [''],
    [null],
    ['   '],
  ])('rejects %s', (url) => {
    expect(validateRemoteUrl(url)).toBe(false);
  });
});

describe('buildDeployEnv', () => {
  it('disables terminal prompts and batches ssh with accept-new host keys', () => {
    const env = buildDeployEnv({ PATH: '/usr/bin' });
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_SSH_COMMAND).toContain('BatchMode=yes');
    expect(env.GIT_SSH_COMMAND).toContain('StrictHostKeyChecking=accept-new');
    expect(env.PATH).toBe('/usr/bin');
  });
});
