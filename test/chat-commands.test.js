import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listCommands } from '../electron/services/chatCommands.cjs';

// `/` completion lists the Session's own Agent's commands and config only.
describe('listCommands per Agent', () => {
  let home;
  let site;
  const write = (file, text = '# command\n') => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-cmds-home-'));
    site = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-cmds-site-'));
    write(path.join(home, '.claude', 'commands', 'deploy.md'));
    write(
      path.join(site, '.claude', 'skills', 'audit', 'SKILL.md'),
      '---\nname: wp-audit\n---\n'
    );
    write(path.join(home, '.gemini', 'antigravity-cli', 'commands', 'agy-only.md'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(site, { recursive: true, force: true });
  });

  const names = (agent) => listCommands(site, agent, { home }).map((c) => c.name);

  it("Claude: its built-ins and its own commands and skills, not Antigravity's", () => {
    const claude = names('claude');
    expect(claude).toEqual(
      expect.arrayContaining(['/compact', '/model', '/deploy', '/wp-audit'])
    );
    expect(claude).not.toContain('/agy-only');
    expect(claude).not.toContain('/permissions');
  });

  it("Codex: Codex's built-ins, no Claude or Antigravity commands", () => {
    const codex = names('codex');
    expect(codex).toEqual(expect.arrayContaining(['/permissions', '/diff', '/new']));
    expect(codex).not.toContain('/deploy');
    expect(codex).not.toContain('/agy-only');
  });

  it("Antigravity: the common commands and its own folder's", () => {
    const agy = names('antigravity');
    expect(agy).toEqual(['/clear', '/help', '/agy-only']);
  });

  it('an unknown Agent gets only the common commands', () => {
    expect(names('something-else')).toEqual(['/clear', '/help']);
  });
});
