const fs = require('fs');

let deps = {
  statSync: fs.statSync,
  openSync: fs.openSync,
  readSync: fs.readSync,
  closeSync: fs.closeSync,
  setInterval: setInterval,
  clearInterval: clearInterval,
};

function __setDeps(newDeps) {
  deps = { ...deps, ...newDeps };
}

const POLL_INTERVAL = 400;

// sessionId -> { viewers, interval, offset, partial, state, path, fd }
const watches = new Map();

function openChat(sessionId, viewerId, { transcriptPath, onRows, decodeLine }) {
  let watch = watches.get(sessionId);
  if (watch) {
    watch.viewers.add(viewerId);
    return;
  }

  watch = {
    viewers: new Set([viewerId]),
    offset: 0,
    partial: Buffer.alloc(0),
    path: transcriptPath,
    interval: null,
    fd: null,
    state: {},
    onRows,
    decodeLine,
  };
  watches.set(sessionId, watch);

  const poll = () => {
    try {
      if (!deps.statSync) return;
      const stat = deps.statSync(watch.path);
      if (stat.size < watch.offset) {
        watch.offset = 0;
        watch.partial = Buffer.alloc(0);
        watch.state = {};
        watch.onRows([{ reset: true }]);
      }
      if (stat.size > watch.offset) {
        if (watch.fd === null) {
          watch.fd = deps.openSync(watch.path, 'r');
        }
        const length = stat.size - watch.offset;
        const buf = Buffer.alloc(length);
        const bytesRead = deps.readSync(watch.fd, buf, 0, length, watch.offset);
        watch.offset += bytesRead;

        const combined = Buffer.concat([watch.partial, buf.slice(0, bytesRead)]);
        let lastNewline = -1;
        const rowsToPush = [];

        for (let i = 0; i < combined.length; i++) {
          if (combined[i] === 0x0a) {
            const lineBuf = combined.slice(lastNewline + 1, i);
            const lineStr = lineBuf.toString('utf8');
            lastNewline = i;

            if (watch.decodeLine) {
              const row = watch.decodeLine(lineStr, watch.state);
              if (row) {
                rowsToPush.push(row);
              }
            }
          }
        }

        if (lastNewline !== -1) {
          watch.partial = combined.slice(lastNewline + 1);
        } else {
          watch.partial = combined;
        }

        if (rowsToPush.length > 0) {
          watch.onRows(rowsToPush);
        }
      }
    } catch {
      // Missing file or read error
    }
  };

  watch.interval = deps.setInterval(poll, POLL_INTERVAL);
  poll();
}

function closeChat(sessionId, viewerId) {
  const watch = watches.get(sessionId);
  if (!watch) return;
  watch.viewers.delete(viewerId);
  if (watch.viewers.size === 0) {
    if (watch.interval) deps.clearInterval(watch.interval);
    if (watch.fd !== null) {
      try {
        deps.closeSync(watch.fd);
      } catch {}
    }
    watches.delete(sessionId);
  }
}

function closeAllChats() {
  for (const watch of watches.values()) {
    if (watch.interval) deps.clearInterval(watch.interval);
    if (watch.fd !== null) {
      try {
        deps.closeSync(watch.fd);
      } catch {}
    }
  }
  watches.clear();
}

module.exports = {
  __setDeps,
  openChat,
  closeChat,
  closeAllChats,
};
