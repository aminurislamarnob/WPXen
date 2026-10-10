import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { locateTranscript, __setDeps } from '../electron/services/transcripts.cjs';

let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-transcripts-'));
  __setDeps({
    homedir: () => home,
    existsSync: fs.existsSync,
    readdirSync: fs.readdirSync,
    readFileSync: fs.readFileSync,
    statSync: fs.statSync,
  });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('locateTranscript', () => {
  it('returns null for unknown agent', () => {
    expect(locateTranscript('unknown', '/some/cwd', 0)).toBeNull();
  });

  describe('Claude', () => {
    it('returns null if .claude/projects/ dir is missing', () => {
      expect(locateTranscript('claude', '/test/cwd', 0)).toBeNull();
    });

    it('locates the most recent file matching cwd and startedAt', () => {
      // Create fake project dir
      const cwd = '/my/test/cwd';
      const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
      const dir = path.join(home, '.claude', 'projects', encoded);
      fs.mkdirSync(dir, { recursive: true });

      // Create a file older than startedAt
      const oldFile = path.join(dir, 'old.jsonl');
      fs.writeFileSync(oldFile, 'old content');
      const now = Date.now();
      fs.utimesSync(oldFile, new Date(now - 10000), new Date(now - 10000));

      // Create a file newer than startedAt
      const newFile = path.join(dir, 'new.jsonl');
      fs.writeFileSync(newFile, 'new content');
      fs.utimesSync(newFile, new Date(now), new Date(now));

      const startedAt = now - 5000;
      const res = locateTranscript('claude', cwd, startedAt);
      expect(res).toBe(newFile);
    });

    it('ignores non-jsonl files', () => {
      const cwd = '/my/test/cwd';
      const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
      const dir = path.join(home, '.claude', 'projects', encoded);
      fs.mkdirSync(dir, { recursive: true });

      const newFile = path.join(dir, 'new.txt');
      fs.writeFileSync(newFile, 'text');
      const now = Date.now();
      fs.utimesSync(newFile, new Date(now), new Date(now));

      expect(locateTranscript('claude', cwd, now - 5000)).toBeNull();
    });
  });

  describe('Codex', () => {
    it('locates rollout transcript by parsing the first line', () => {
      const cwd = '/my/codex/cwd';
      const sessionsDir = path.join(home, '.codex', 'sessions');

      const now = new Date();
      const year = now.getFullYear().toString();
      const month = (now.getMonth() + 1).toString().padStart(2, '0');
      const day = now.getDate().toString().padStart(2, '0');

      const dDir = path.join(sessionsDir, year, month, day);
      fs.mkdirSync(dDir, { recursive: true });

      // old file, wrong cwd
      const file1 = path.join(dDir, 'rollout-1.jsonl');
      fs.writeFileSync(
        file1,
        JSON.stringify({ type: 'session_meta', payload: { cwd: '/wrong' } }) + '\n'
      );

      // new file, right cwd
      const file2 = path.join(dDir, 'rollout-2.jsonl');
      fs.writeFileSync(
        file2,
        JSON.stringify({ type: 'session_meta', payload: { cwd } }) + '\n'
      );

      // newer file, but not a rollout-*.jsonl
      const file3 = path.join(dDir, 'other.jsonl');
      fs.writeFileSync(
        file3,
        JSON.stringify({ type: 'session_meta', payload: { cwd } }) + '\n'
      );

      const startedAt = now.getTime() - 10000;

      const res = locateTranscript('codex', cwd, startedAt);
      expect(res).toBe(file2);
    });
  });

  describe('Antigravity', () => {
    it('locates transcript using last_conversations.json mapping', () => {
      const cwd = '/my/agy/cwd';
      const convId = '123-abc';
      const cacheDir = path.join(home, '.gemini', 'antigravity-cli', 'cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(
        path.join(cacheDir, 'last_conversations.json'),
        JSON.stringify({
          [cwd]: convId,
        })
      );

      const brainDir = path.join(
        home,
        '.gemini',
        'antigravity-cli',
        'brain',
        convId,
        '.system_generated',
        'logs'
      );
      fs.mkdirSync(brainDir, { recursive: true });
      const transcriptPath = path.join(brainDir, 'transcript.jsonl');
      fs.writeFileSync(transcriptPath, 'hello');

      const res = locateTranscript('antigravity', cwd, 0);
      expect(res).toBe(transcriptPath);
    });

    it('returns null if mapping not found', () => {
      const cwd = '/my/agy/cwd';
      const cacheDir = path.join(home, '.gemini', 'antigravity-cli', 'cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(
        path.join(cacheDir, 'last_conversations.json'),
        JSON.stringify({
          '/some/other': '123-abc',
        })
      );

      const res = locateTranscript('antigravity', cwd, 0);
      expect(res).toBeNull();
    });

    it('returns null if file does not exist', () => {
      const cwd = '/my/agy/cwd';
      const cacheDir = path.join(home, '.gemini', 'antigravity-cli', 'cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(
        path.join(cacheDir, 'last_conversations.json'),
        JSON.stringify({
          [cwd]: '123-abc',
        })
      );
      // don't create transcript file
      const res = locateTranscript('antigravity', cwd, 0);
      expect(res).toBeNull();
    });
  });
});
