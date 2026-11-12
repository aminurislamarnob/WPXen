'use strict';

// The endpoint the 502 page talks to, through nginx (errorPages.cjs proxies
// /__wpxen/repair and /__wpxen/status here with the request's host).
//
// A Unix socket and nothing else: no TCP listener, so no web page and no
// other machine can reach it except through a Site's own vhost. Two routes,
// one method each, and the host is the only input — it is handed to the
// repairer (repair.cjs), which answers null for anything that is no known
// Site. Paths, query strings and bodies are never read.

const fs = require('fs');
const http = require('http');
const path = require('path');

// Names that carry the app's name outside its bundle (see CLAUDE.md, "Legacy
// names"): the URL prefix the shared nginx snippet reserves on every Site.
// repair.cjs re-exports it; it lives here so this module needs nothing back.
const RESERVED_PREFIX = '/__wpxen/';

const ROUTES = {
  [`${RESERVED_PREFIX}repair`]: 'POST',
  [`${RESERVED_PREFIX}status`]: 'GET',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function handle(repairer, req, res) {
  req.resume(); // never read the body; just let it drain
  const pathname = String(req.url || '').split('?')[0];
  const method = ROUTES[pathname];
  if (!method) return send(res, 404, { error: 'Not found' });
  if (req.method !== method) {
    return send(res, 405, { error: 'Method not allowed' }, { Allow: method });
  }
  const host = String(req.headers.host || '');
  try {
    if (!repairer.status(host)) {
      return send(res, 403, { error: "WPXen doesn't manage this host." });
    }
    if (method === 'POST') {
      // Answer with the state the repair has just entered; the page polls
      // status for the outcome.
      repairer.repair(host).catch(() => {});
    }
    return send(res, 200, repairer.status(host));
  } catch (err) {
    return send(res, 500, { error: (err && err.message) || 'Repair failed' });
  }
}

// Listens on `socketPath`, replacing a stale socket file left by a crash (the
// app holds a single-instance lock, so nothing live owns it). Resolves to
// { address(), close() }; close() also removes the socket file.
function listen({ socketPath, repairer }) {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  fs.rmSync(socketPath, { force: true });
  const server = http.createServer((req, res) => handle(repairer, req, res));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      try {
        // Same user as nginx's workers (an unprivileged child of the app).
        fs.chmodSync(socketPath, 0o600);
      } catch {}
      resolve({
        address: () => server.address(),
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => {
              fs.rmSync(socketPath, { force: true });
              done();
            });
          }),
      });
    });
  });
}

module.exports = { listen, ROUTES, RESERVED_PREFIX };
