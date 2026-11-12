'use strict';

// WPXen's nginx error pages. One shared snippet, included by every Site's
// vhost, turns nginx's bare "502 Bad Gateway" into a page that asks the app to
// repair the Site's PHP-FPM (repair.cjs, over the Unix socket the snippet
// proxies to) and reloads the Site once PHP is back. Keeping the rules in one
// file means changing them later rewrites one file, not every vhost.
//
// Both files live outside the bundle, in a WPXen-owned folder beside nginx's
// own config — and deliberately NOT in servers/: nginx.conf globs servers/*
// at http level, where a snippet of server-level directives fails `nginx -t`.

const fs = require('fs');
const path = require('path');
const repair = require('./repair.cjs');

// Names that carry the app's name outside its bundle (see CLAUDE.md, "Legacy
// names") — a future rename has to find and migrate these.
const ERROR_PAGES_DIR = 'wpxen'; // {prefix}/etc/nginx/<dir>/
const ERROR_SNIPPET_NAME = 'wpxen-errors.conf';
const PAGE_502_NAME = '502.html';

// The page's own repair budget, per tab: automatic repair stops after this
// many attempts in the window, and the page offers Try again instead. The app
// enforces its own, independent per-Site limit (repair.cjs).
const PAGE_MAX_ATTEMPTS = 2;
const PAGE_WINDOW_MS = 60_000;

const RESERVED = repair.RESERVED_PREFIX; // '/__wpxen/'

// A path interpolated into nginx config: absolute, and nothing nginx would
// read as the end of a token or directive. The socket path in particular can't
// hold a space — `unix:` takes it bare — which is why it isn't in userData.
function assertNginxPath(p, what) {
  if (typeof p !== 'string' || !p.startsWith('/') || /[\s;{}'"\\\0]/.test(p)) {
    throw new Error(`Unsafe ${what} for nginx config: ${p}`);
  }
}

function errorPagesDir(confDir) {
  return confDir ? path.join(confDir, ERROR_PAGES_DIR) : null;
}

function snippetPath(confDir) {
  const dir = errorPagesDir(confDir);
  return dir ? path.join(dir, ERROR_SNIPPET_NAME) : null;
}

// The shared snippet, included inside each Site's server {} block. Pure.
// The two app routes are exact locations proxied to the socket with the
// request's host (the app identifies the Site by it); the rest of the
// reserved prefix is a 404 so it never falls through to WordPress.
function buildErrorSnippet({ socketPath, pagesDir }) {
  assertNginxPath(socketPath, 'repair socket path');
  assertNginxPath(pagesDir, 'error page folder');
  const upstream = `http://unix:${socketPath}:`;
  const route = (name) => `location = ${RESERVED}${name} {
    proxy_pass ${upstream};
    proxy_set_header Host $host;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_read_timeout 10s;
    access_log off;
}`;
  return `# Managed by WPXen — rewritten whenever nginx starts; edits are overwritten.
# Included inside every Site's server {} block.

error_page 502 ${RESERVED}${PAGE_502_NAME};

location = ${RESERVED}${PAGE_502_NAME} {
    internal;
    alias ${pagesDir}/${PAGE_502_NAME};
    default_type text/html;
    add_header Cache-Control "no-store" always;
}

${route('repair')}

${route('status')}

location ^~ ${RESERVED} {
    return 404;
}
`;
}

// The page's attempt limiter, per tab. Pure and self-contained: its source is
// embedded verbatim in the page (see build502Page), so it may not reference
// anything outside itself. `history` is whatever sessionStorage held —
// possibly garbage — and timestamps outside [now - window, now] are dropped,
// so a clock that moved backwards can't block repair forever.
function nextAttempt(history, now, max = 2, windowMs = 60000) {
  const recent = (Array.isArray(history) ? history : []).filter(
    (t) => typeof t === 'number' && t <= now && now - t < windowMs
  );
  if (recent.length >= max) return { allowed: false, history: recent };
  return { allowed: true, history: recent.concat(now) };
}

const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

// The static 502 page. Self-contained (no network but its own Site), styled
// after the app's tokens, light/dark by the system appearance.
function build502Page({ logPath }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>PHP isn't responding · WPXen</title>
<style>
  :root { --bg: #ffffff; --fg: #252525; --card: #f7f7f7; --border: #e7e7e7;
    --muted: #828282; --blue: #0a60ff; --danger: #dc2626; --btn: #343434; --btn-fg: #fbfbfb; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #151110; --fg: #eae8e6; --card: #201e1c; --border: #2a2827;
      --muted: #a8a5a3; --blue: #0a84ff; --danger: #cc4444; --btn: #eae8e6; --btn-fg: #151110; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 16px; background: var(--bg); color: var(--fg);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 480px; background: var(--card); border: 1px solid var(--border);
    border-radius: 14px; padding: 24px; }
  h1 { font-size: 17px; margin: 0 0 4px; }
  p { margin: 0; color: var(--muted); }
  .status { display: flex; align-items: center; gap: 8px; margin-top: 16px; color: var(--fg); }
  .spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--border);
    border-top-color: var(--blue); animation: spin 0.8s linear infinite; flex: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  [hidden] { display: none !important; }
  pre { margin: 12px 0 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px;
    background: var(--bg); color: var(--danger); font: 12px/1.5 ui-monospace, Menlo, monospace;
    white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto; }
  .actions { margin-top: 16px; }
  button { height: 32px; padding: 0 12px; border: 0; border-radius: 8px; background: var(--btn);
    color: var(--btn-fg); font: inherit; font-size: 13px; cursor: pointer; }
  .log { margin-top: 12px; font-size: 12px; }
  code { font: 12px ui-monospace, Menlo, monospace; color: var(--fg); word-break: break-all; }
</style>
</head>
<body>
<main>
  <h1>This Site's PHP stopped responding</h1>
  <p>WPXen restarts it, then reloads this page on its own.</p>
  <div class="status"><span class="spinner" id="spinner"></span><span id="message">Asking WPXen to restart PHP…</span></div>
  <pre id="error" hidden></pre>
  <div class="actions" id="stopped" hidden>
    <button type="button" id="retry">Try again</button>
    <p class="log">PHP error log: <code>${escapeHtml(logPath)}</code></p>
  </div>
  <noscript><p class="log">Turn on JavaScript to let this page repair PHP, or restart PHP from the WPXen app.</p></noscript>
</main>
<script>
(function () {
  var KEY = 'wpxen.repairAttempts';
  var MAX = ${PAGE_MAX_ATTEMPTS};
  var WINDOW_MS = ${PAGE_WINDOW_MS};
  var POLL_MS = 1000;
  var POLL_LIMIT_MS = 30000;

  ${nextAttempt.toString()}

  var $ = function (id) { return document.getElementById(id); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  function loadHistory() {
    try { return JSON.parse(sessionStorage.getItem(KEY)); } catch (e) { return []; }
  }
  function saveHistory(h) {
    try { sessionStorage.setItem(KEY, JSON.stringify(h)); } catch (e) {}
  }

  function show(text) {
    $('message').textContent = text;
    $('spinner').hidden = false;
    $('stopped').hidden = true;
    $('error').hidden = true;
  }
  function stop(text, error) {
    $('message').textContent = text;
    $('spinner').hidden = true;
    $('stopped').hidden = false;
    $('error').textContent = error || '';
    $('error').hidden = !error;
  }

  async function call(method, url) {
    var res = await fetch(url, { method: method, cache: 'no-store', credentials: 'same-origin' });
    var body = null;
    try { body = await res.json(); } catch (e) {}
    if (!res.ok || !body) {
      throw new Error((body && body.error) || 'WPXen didn\\'t answer (HTTP ' + res.status + '). Is the app running?');
    }
    return body;
  }

  // The Site is back once the original URL stops answering 502.
  async function siteUp() {
    try {
      var res = await fetch(location.href, { method: 'HEAD', cache: 'no-store', redirect: 'manual' });
      return res.status !== 502;
    } catch (e) {
      return false;
    }
  }

  function phpLabel(st) {
    return st && st.phpVersion ? 'PHP ' + st.phpVersion : 'PHP';
  }

  async function attempt() {
    show('Asking WPXen to restart PHP…');
    var st;
    try {
      st = await call('POST', '/__wpxen/repair');
      var deadline = Date.now() + POLL_LIMIT_MS;
      while (st.state === 'repairing' && Date.now() < deadline) {
        show('Restarting ' + phpLabel(st) + '…');
        await sleep(POLL_MS);
        st = await call('GET', '/__wpxen/status');
      }
    } catch (e) {
      return auto(e.message);
    }
    if (st.state === 'healthy') {
      show(phpLabel(st) + ' is back. Reloading…');
      if (await siteUp()) return location.reload();
      return auto(phpLabel(st) + ' restarted, but the Site still answers 502.');
    }
    if (st.state === 'limited') {
      return stop('WPXen stopped restarting ' + phpLabel(st) + ' for now.', st.error);
    }
    if (st.state === 'repairing') return auto(phpLabel(st) + ' is taking too long to restart.');
    auto(st.error || 'Restarting ' + phpLabel(st) + ' didn\\'t help.');
  }

  // Automatic repair, within the per-tab budget.
  function auto(lastError) {
    var next = nextAttempt(loadHistory(), Date.now(), MAX, WINDOW_MS);
    saveHistory(next.history);
    if (!next.allowed) return stop('Automatic repair stopped after ' + MAX + ' attempts in a minute.', lastError);
    attempt();
  }

  // A click is the user's own attempt: it skips the page's budget (the app
  // still applies its own).
  $('retry').addEventListener('click', function () { attempt(); });

  auto(null);
})();
</script>
</body>
</html>
`;
}

// Writes the snippet and the page, rewriting only what changed. Must run
// before any vhost that includes the snippet is written or nginx is tested —
// an include of a missing file fails `nginx -t`. Returns the snippet path.
function ensureErrorPages({ confDir, prefix }) {
  const dir = errorPagesDir(confDir);
  if (!dir || !prefix) throw new Error('nginx config folder not found');
  fs.mkdirSync(dir, { recursive: true });
  const files = {
    [ERROR_SNIPPET_NAME]: buildErrorSnippet({
      socketPath: repair.repairSocketPath(prefix),
      pagesDir: dir,
    }),
    [PAGE_502_NAME]: build502Page({ logPath: `${prefix}/var/log/php-fpm.log` }),
  };
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    let current = null;
    try {
      current = fs.readFileSync(p, 'utf8');
    } catch {}
    if (current !== content) fs.writeFileSync(p, content, 'utf8');
  }
  return { snippetPath: path.join(dir, ERROR_SNIPPET_NAME) };
}

module.exports = {
  ERROR_PAGES_DIR,
  ERROR_SNIPPET_NAME,
  PAGE_502_NAME,
  snippetPath,
  buildErrorSnippet,
  build502Page,
  nextAttempt,
  ensureErrorPages,
};
