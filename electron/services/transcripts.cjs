const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

let deps = {
  homedir: os.homedir,
  readdirSync: fs.readdirSync,
  statSync: fs.statSync,
  readFileSync: fs.readFileSync,
  existsSync: fs.existsSync,
  openSync: fs.openSync,
  readSync: fs.readSync,
  closeSync: fs.closeSync,
};

function __setDeps(newDeps) {
  deps = { ...deps, ...newDeps };
}

const { claudeTranscriptPath } = require('./agentChatClaude.cjs');

// The first bytes of a file, or '' when it can't be read.
const HEAD_BYTES = 64 * 1024;
function readHead(file, bytes = HEAD_BYTES) {
  let fd = null;
  try {
    fd = deps.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = deps.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        deps.closeSync(fd);
      } catch {}
    }
  }
}

function locateClaude({ cwd, startedAt, home, transcriptId }) {
  // A pinned Session has exactly one transcript. Until Claude writes it (the
  // first prompt creates the file) there is none — guessing by recency here
  // would hand this Session a sibling's conversation from the same folder.
  if (transcriptId) {
    let pinned = null;
    try {
      pinned = claudeTranscriptPath({ home, cwd, uuid: transcriptId });
    } catch {
      return null; // the cwd is gone
    }
    return pinned && deps.existsSync(pinned) ? pinned : null;
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

function locateCodex({ cwd, startedAt, home, exclude }) {
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
            // A rollout already driving another Session is not ours.
            if (exclude && exclude.has(full)) continue;
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

function antigravityMapPath(home) {
  return path.join(
    home,
    '.gemini',
    'antigravity-cli',
    'cache',
    'last_conversations.json'
  );
}

function antigravityTranscriptPath(home, convId) {
  return path.join(
    home,
    '.gemini',
    'antigravity-cli',
    'brain',
    convId,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  );
}

// The conversation id currently mapped to a working folder, or null. The map
// changes when a new conversation starts — re-read it every time.
function antigravityConversationId(cwd, home) {
  const lastPath = antigravityMapPath(home || deps.homedir());
  try {
    if (!deps.existsSync(lastPath)) return null;
    const map = JSON.parse(deps.readFileSync(lastPath, 'utf8'));
    return map[cwd] || null;
  } catch {
    return null;
  }
}

// When a conversation began: its first record's created_at (written before
// the content, so it sits in the head however long the prompt), else the
// transcript's birth time; null when neither says.
function antigravityStartedMs(transcript) {
  const match = /"created_at":"([^"]+)"/.exec(readHead(transcript, 4096));
  const created = match ? Date.parse(match[1]) : NaN;
  if (Number.isFinite(created)) return created;
  try {
    const { birthtimeMs } = deps.statSync(transcript);
    return Number.isFinite(birthtimeMs) && birthtimeMs > 0 ? birthtimeMs : null;
  } catch {
    return null;
  }
}

// created_at has second resolution: allow that, and a little clock slack.
const ANTIGRAVITY_START_SKEW_MS = 5_000;

function locateAntigravity({ cwd, home, exclude, startedAt }) {
  const convId = antigravityConversationId(cwd, home);
  if (!convId) return null;
  const transcript = antigravityTranscriptPath(home, convId);
  // A transcript already driving another Session is not ours.
  if (exclude && exclude.has(transcript)) return null;
  try {
    if (!deps.existsSync(transcript)) return null;
  } catch {
    return null;
  }
  // The folder keeps pointing at its last conversation until a new one
  // starts — the first prompt of this Session creates it. One that began
  // before the Session is an earlier run's history, never this one's.
  const sessionStart = Number(startedAt);
  if (Number.isFinite(sessionStart) && sessionStart > 0) {
    const began = antigravityStartedMs(transcript);
    if (began !== null && began < sessionStart - ANTIGRAVITY_START_SKEW_MS) return null;
  }
  return transcript;
}

const REGISTRY = {
  claude: locateClaude,
  codex: locateCodex,
  antigravity: locateAntigravity,
};

function locateTranscript(agentId, cwd, startedAt, transcriptId, exclude, home) {
  const locator = REGISTRY[agentId];
  if (!locator) return null;
  return locator({
    cwd,
    startedAt,
    home: home || deps.homedir(),
    transcriptId,
    exclude,
  });
}

module.exports = {
  __setDeps,
  locateTranscript,
  antigravityConversationId,
  antigravityTranscriptPath,
};
