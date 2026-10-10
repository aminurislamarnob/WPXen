const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

let deps = {
  homedir: os.homedir,
  readdirSync: fs.readdirSync,
  statSync: fs.statSync,
  readFileSync: fs.readFileSync,
  existsSync: fs.existsSync,
};

function __setDeps(newDeps) {
  deps = { ...deps, ...newDeps };
}

const { claudeTranscriptPath } = require('./agentChatClaude.cjs');

function locateClaude({ cwd, startedAt, home, transcriptId }) {
  if (transcriptId) {
    const pinned = claudeTranscriptPath({ home, cwd, uuid: transcriptId });
    if (pinned && deps.existsSync(pinned)) return pinned;
  }

  // Claude replaces each non-alphanumeric character with '-'
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const dir = path.join(home, '.claude', 'projects', encoded);
  if (!deps.existsSync(dir)) return null;

  const files = deps.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  let latest = null;
  let maxMtime = -1;

  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const stat = deps.statSync(full);
      if (stat.mtimeMs >= startedAt && stat.mtimeMs > maxMtime) {
        maxMtime = stat.mtimeMs;
        latest = full;
      }
    } catch {
      // skip
    }
  }
  return latest;
}

function locateCodex({ cwd, startedAt, home }) {
  const sessionsDir = path.join(home, '.codex', 'sessions');
  if (!deps.existsSync(sessionsDir)) return null;

  // Scan YYYY/MM/DD folders
  let latest = null;
  let maxMtime = -1;

  const start = new Date(startedAt);
  const startY = start.getFullYear();
  const startM = start.getMonth() + 1;
  const startD = start.getDate();

  try {
    const years = deps
      .readdirSync(sessionsDir)
      .filter((y) => !isNaN(y) && Number(y) >= startY);
    for (const year of years) {
      const yDir = path.join(sessionsDir, year);
      const months = deps.readdirSync(yDir).filter((m) => !isNaN(m));
      for (const month of months) {
        if (Number(year) === startY && Number(month) < startM) continue;
        const mDir = path.join(yDir, month);
        const days = deps.readdirSync(mDir).filter((d) => !isNaN(d));
        for (const day of days) {
          if (Number(year) === startY && Number(month) === startM && Number(day) < startD)
            continue;
          const dDir = path.join(mDir, day);
          const files = deps
            .readdirSync(dDir)
            .filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'));

          for (const f of files) {
            const full = path.join(dDir, f);
            try {
              const stat = deps.statSync(full);
              if (stat.mtimeMs >= startedAt && stat.mtimeMs > maxMtime) {
                // Read first line
                const content = deps.readFileSync(full, 'utf8');
                const firstLine = content.split('\n')[0];
                if (firstLine) {
                  const meta = JSON.parse(firstLine);
                  if (
                    meta.type === 'session_meta' &&
                    meta.payload &&
                    meta.payload.cwd === cwd
                  ) {
                    maxMtime = stat.mtimeMs;
                    latest = full;
                  }
                }
              }
            } catch {
              // skip
            }
          }
        }
      }
    }
  } catch {
    // skip
  }

  return latest;
}

function locateAntigravity({ cwd, home }) {
  const lastPath = path.join(
    home,
    '.gemini',
    'antigravity-cli',
    'cache',
    'last_conversations.json'
  );
  if (!deps.existsSync(lastPath)) return null;

  try {
    const content = deps.readFileSync(lastPath, 'utf8');
    const map = JSON.parse(content);
    const convId = map[cwd];
    if (convId) {
      const transcript = path.join(
        home,
        '.gemini',
        'antigravity-cli',
        'brain',
        convId,
        '.system_generated',
        'logs',
        'transcript.jsonl'
      );
      if (deps.existsSync(transcript)) {
        return transcript;
      }
    }
  } catch {
    // skip
  }
  return null;
}

const REGISTRY = {
  claude: locateClaude,
  codex: locateCodex,
  antigravity: locateAntigravity,
};

function locateTranscript(agentId, cwd, startedAt, transcriptId) {
  const locator = REGISTRY[agentId];
  if (!locator) return null;
  return locator({ cwd, startedAt, home: deps.homedir(), transcriptId });
}

module.exports = {
  __setDeps,
  locateTranscript,
};
