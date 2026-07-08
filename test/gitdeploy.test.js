import { describe, it, expect } from 'vitest';
import gitdeploy from '../electron/services/gitdeploy.cjs';

describe('isValidRemoteUrl', () => {
  it('accepts common remote forms', () => {
    expect(gitdeploy.isValidRemoteUrl('https://github.com/me/site.git')).toBe(true);
    expect(gitdeploy.isValidRemoteUrl('git@github.com:me/site.git')).toBe(true);
    expect(gitdeploy.isValidRemoteUrl('ssh://git@gitlab.com/me/site.git')).toBe(true);
  });

  it('rejects garbage, options, and injection-shaped input', () => {
    expect(gitdeploy.isValidRemoteUrl('')).toBe(false);
    expect(gitdeploy.isValidRemoteUrl('   ')).toBe(false);
    expect(gitdeploy.isValidRemoteUrl('--upload-pack=/bin/sh')).toBe(false);
    expect(gitdeploy.isValidRemoteUrl('https://host/repo with space')).toBe(false);
    expect(gitdeploy.isValidRemoteUrl('file:///etc/passwd')).toBe(false);
    expect(gitdeploy.isValidRemoteUrl(null)).toBe(false);
  });
});

describe('isValidBranch', () => {
  it('accepts normal branch names', () => {
    expect(gitdeploy.isValidBranch('main')).toBe(true);
    expect(gitdeploy.isValidBranch('deploy/production')).toBe(true);
    expect(gitdeploy.isValidBranch('release-1.2')).toBe(true);
  });

  it('rejects option-shaped and traversal names', () => {
    expect(gitdeploy.isValidBranch('-f')).toBe(false);
    expect(gitdeploy.isValidBranch('a..b')).toBe(false);
    expect(gitdeploy.isValidBranch('has space')).toBe(false);
    expect(gitdeploy.isValidBranch('')).toBe(false);
  });
});

describe('countPorcelainEntries', () => {
  it('counts non-empty lines', () => {
    expect(gitdeploy.countPorcelainEntries(' M a.php\n?? new.txt\n')).toBe(2);
    expect(gitdeploy.countPorcelainEntries('')).toBe(0);
    expect(gitdeploy.countPorcelainEntries('\n\n')).toBe(0);
    expect(gitdeploy.countPorcelainEntries(null)).toBe(0);
  });
});

describe('managed .gitignore', () => {
  it('excludes wp-config.php by default', () => {
    expect(gitdeploy.GITIGNORE_CONTENT).toMatch(/^wp-config\.php$/m);
    expect(gitdeploy.GITIGNORE_CONTENT).toMatch(/node_modules/);
  });
});
