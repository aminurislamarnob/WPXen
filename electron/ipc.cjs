'use strict';

const {
  ipcMain,
  shell,
  dialog,
  app,
  BrowserWindow,
  nativeTheme,
  session,
} = require('electron');
const crypto = require('crypto');
const path = require('path');
const os = require('os');

// The single sanctioned way out of the app — see services/safeUrl.cjs.
const { openExternalSafely } = require('./services/safeUrl.cjs');

const fs = require('fs');
const brew = require('./services/brew.cjs');
const nginx = require('./services/nginx.cjs');
const phpService = require('./services/php.cjs');
const mysql = require('./services/mysql.cjs');
const dnsmasq = require('./services/dnsmasq.cjs');
const wordpress = require('./services/wordpress.cjs');
const siteops = require('./services/siteops.cjs');
const blueprints = require('./services/blueprints.cjs');
const mkcert = require('./services/mkcert.cjs');
const phpmyadmin = require('./services/phpmyadmin.cjs');
const mailpit = require('./services/mailpit.cjs');
const procman = require('./services/procman.cjs');
const cloudflared = require('./services/cloudflared.cjs');
const sudoers = require('./services/sudoers.cjs');
const setup = require('./services/setup.cjs');
const logs = require('./services/logs.cjs');
const validation = require('./services/validation.cjs');
const agents = require('./services/agents.cjs');
const files = require('./services/files.cjs');
const git = require('./services/git.cjs');
const browser = require('./services/browser.cjs');
const browserHistory = require('./services/browserHistory.cjs');
const settingsService = require('./services/settings.cjs');
const externalTools = require('./services/externalTools.cjs');
const { humanize } = require('./services/errors.cjs');

let store;
let mainWindow;
// Schema-backed settings, bound to the store in registerHandlers().
let settings;
let serviceStatusCache = {
  nginx: { running: false, name: 'nginx' },
  php: { running: false, name: 'PHP-FPM', version: null },
  mysql: { running: false, name: 'MySQL' },
  dnsmasq: { running: false, name: 'dnsmasq' },
  mailpit: { running: false, name: 'Mailpit', installed: false },
};

// Switches a site between http and https: mints a cert (via the local CA) when
// enabling, rewrites the vhost, reloads nginx and repoints WordPress at the new
// URL. Returns the updated site record; the caller persists it. Shared by the
// set-site-https handler and HTTPS-on-create.
function applyHttps(site, enabled) {
  let updated;
  if (enabled) {
    // Ensure mkcert + a trusted local CA, then mint a cert for this domain.
    mkcert.ensureInstalled();
    mkcert.ensureCA();
    const { certPath, keyPath } = mkcert.generateCert(site.domain);
    updated = {
      ...site,
      https: true,
      certPath,
      keyPath,
      url: `https://${site.domain}`,
    };
  } else {
    updated = { ...site, https: false, url: `http://${site.domain}` };
  }

  // Rewrite the vhost for the new scheme and reload nginx.
  nginx.createSiteConfig(updated);
  nginx.reload();

  // Point WordPress at the new URL so it stops redirecting to the old
  // scheme. Best-effort — nginx already serves the right scheme regardless.
  try {
    wordpress.setSiteUrl(site.path, updated.url);
  } catch {}

  return updated;
}

// Hands the agent launcher its user configuration. An empty enabled list means
// "all agents", not "none" — see the schema note.
function applyAgentConfig(all) {
  const enabled = all['agents.enabled'];
  agents.setConfig({
    enabled: enabled && enabled.length ? enabled : null,
    commands: all['agents.commands'],
    custom: all['agents.custom']?.list || [],
  });
}

// Pushes the full resolved settings to every open window so a change made in
// one place (tray, Mail page, Settings) lands everywhere.
function broadcastSettings(all) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.webContents) {
      win.webContents.send('settings-updated', all);
    }
  }
}

// Synchronous, instant — returns the last computed snapshot. Used by the tray
// and the get-service-status IPC reply so neither blocks on subprocesses.
function getServiceStatus() {
  return serviceStatusCache;
}

// Recomputes the snapshot using non-blocking async probes run in parallel, so
// the main-thread event loop stays free (no macOS spinning-wait cursor).
async function computeServiceStatus() {
  const [
    nginxRunning,
    mysqlRunning,
    dnsmasqRunning,
    activePhp,
    phpRunning,
    mailpitRunning,
  ] = await Promise.all([
    nginx.isRunningAsync(),
    mysql.isRunningAsync(),
    dnsmasq.isRunningAsync(),
    brew.getActivePhpVersionAsync(),
    phpService.isPhpFpmRunningAsync(),
    mailpit.isRunningAsync(),
  ]);

  // Supervisor view of each converted service: whether WPXen owns the
  // process, its lifecycle state, and any crash-loop error for the UI. The
  // probe-based `running` booleans above stay the source of truth (they also
  // see instances we didn't spawn).
  const procInfo = (name) => {
    const s = procman.status(name);
    return { managed: procman.isSupervised(name), state: s.state, error: s.error };
  };

  serviceStatusCache = {
    nginx: { running: nginxRunning, name: 'nginx', ...procInfo('nginx') },
    php: {
      running: phpRunning,
      name: 'PHP-FPM',
      version: activePhp,
      fpmVersion: phpService.getRunningFpmVersion(),
      ...procInfo('php'),
    },
    mysql: { running: mysqlRunning, name: 'MySQL', ...procInfo('mysql') },
    dnsmasq: { running: dnsmasqRunning, name: 'dnsmasq' },
    mailpit: {
      running: mailpitRunning,
      name: 'Mailpit',
      installed: mailpit.isInstalled(),
      ...procInfo('mailpit'),
    },
  };
  return serviceStatusCache;
}

// Coalesces concurrent refreshes (poller + on-demand IPC) into one in-flight
// computation so probes don't pile up on top of each other.
let statusRefreshInFlight = null;
function refreshServiceStatus() {
  if (!statusRefreshInFlight) {
    statusRefreshInFlight = computeServiceStatus().finally(() => {
      statusRefreshInFlight = null;
    });
  }
  return statusRefreshInFlight;
}

// Force-rechecks Homebrew dependencies and pushes the fresh result to the
// renderer. Rate-limited so rapid window-focus events can't spawn `brew list`
// storms — one real re-check every few seconds at most.
let lastDepsRefresh = 0;
async function refreshDependencies(win, { minIntervalMs = 3000 } = {}) {
  const now = Date.now();
  if (now - lastDepsRefresh < minIntervalMs) return;
  lastDepsRefresh = now;
  try {
    const deps = await brew.checkAllDependenciesAsync(true);
    if (win && !win.isDestroyed() && win.webContents) {
      win.webContents.send('dependencies-update', deps);
    }
  } catch {}
}

function registerHandlers(win, storeInstance) {
  mainWindow = win;
  store = storeInstance;
  // The in-app browser pushes guest events (new windows, and later console
  // output) back to the renderer through this window.
  browser.setWindow(win);

  // Bind the settings schema to the store. Side effects that used to live in
  // the save-settings ladder hang off `effects` — one place per key, run only
  // when that key actually changed.
  settings = settingsService.createSettings({
    store,
    defaults: {
      'sites.dir': () => wordpress.DEFAULT_SITES_DIR,
      'php.defaultVersion': () => brew.getActivePhpVersion() || '',
    },
    effects: {
      'app.startAtLogin': (value) => app.setLoginItemSettings({ openAtLogin: value }),
      'db.user': (_v, all) =>
        mysql.setCredentials({ user: all['db.user'], password: all['db.password'] }),
      'db.password': (_v, all) =>
        mysql.setCredentials({ user: all['db.user'], password: all['db.password'] }),
      'mail.catch': (value) => mailpit.setCatchEnabled(value),
      'services.logMaxSizeMb': (value) => procman.setMaxLogSizeMb(value),
      // themeSource forces prefers-color-scheme in the renderer, so the
      // semantic tokens and the opaque window backdrop both follow.
      'appearance.themeMode': (value) => {
        nativeTheme.themeSource = value;
      },
      'agents.enabled': (_v, all) => applyAgentConfig(all),
      'agents.commands': (_v, all) => applyAgentConfig(all),
      'agents.custom': (_v, all) => applyAgentConfig(all),
    },
  });
  settings.migrateLegacy();

  // Apply settings that configure a module at startup rather than on change.
  procman.setMaxLogSizeMb(settings.get('services.logMaxSizeMb'));
  nativeTheme.themeSource = settings.get('appearance.themeMode');
  applyAgentConfig(settings.read());

  // Apply persisted DB credentials so MySQL operations authenticate correctly.
  mysql.setCredentials({
    user: settings.get('db.user'),
    password: settings.get('db.password'),
  });

  // Populate the status cache once at startup (non-blocking).
  refreshServiceStatus();

  // Crashes/restarts of supervised children surface in the UI immediately
  // instead of waiting for the next 5s poll tick.
  procman.onStateChange(() => {
    refreshServiceStatus().then(() => {
      if (win && !win.isDestroyed() && win.webContents) {
        win.webContents.send('service-status-update', getServiceStatus());
      }
    });
  });

  // ── Agent Launcher (see services/agents.cjs) ──────────────────────────────
  // (findSite is declared below in this same function scope — hoisted.)
  ipcMain.handle('agent-list', () => agents.listAgents());

  // Every agent including hidden ones — the Agents settings section needs the
  // full list to render its enable/disable toggles. The plain shell is left out:
  // it has no binary to detect, no command to override, and is always available.
  ipcMain.handle('agent-list-all', () => agents.listAgents({ all: true, shell: false }));

  // One-click Homebrew install for an Agent's CLI, streaming brew's output the
  // same way the PHP version installer does. Only agents carrying a vetted
  // `brew` target reach here; the service rejects the rest.
  ipcMain.handle('agent-install', async (event, agentId) => {
    try {
      const progress = (line) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('agent-install-progress', { agentId, line });
        }
      };
      await agents.installAgent(agentId, progress);
      // A cask can drop its binary somewhere brew has just linked, so re-probe
      // rather than trusting the caller's stale list.
      const agent = agents
        .listAgents({ all: true, shell: false })
        .find((a) => a.id === agentId);
      return { success: true, detected: !!agent?.detected, path: agent?.path || null };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  // The live Sessions for a Site — the renderer restores its terminal tabs.
  ipcMain.handle('agent-sessions', (_e, siteId) => agents.listSessions(siteId));

  // Launch an Agent for a Site. Always spawns a NEW Session (many per Site are
  // allowed), returning its sessionId for the renderer to attach a terminal to.
  // `targetId` (optional) selects a saved Launch Target on the Site; without it
  // the Agent runs at the webroot with its global default flags applied.
  ipcMain.handle('agent-launch', (_e, siteId, agentId, targetId) => {
    const site = findSite(siteId);
    if (!site) return { error: 'Site not found' };
    const globalArgs = store.get('agentPresets', {})[agentId]?.args || '';
    let target = null;
    if (targetId) {
      target = (site.launchTargets || []).find((t) => t.id === targetId) || null;
      if (!target) return { error: 'Launch target not found' };
    }
    return agents.launch({ site, agentId, target, globalArgs });
  });

  // ── Launch Presets (global, per-Agent) & Launch Targets (per-Site) ─────────
  // Global default flags typed for an Agent on every launch, keyed by agentId:
  // { [agentId]: { args } }. `resolveLaunch` treats an absent/empty entry as
  // "just the bare command".
  ipcMain.handle('agent-presets-get', () => store.get('agentPresets', {}));

  ipcMain.handle('agent-preset-set', (_e, agentId, args) => {
    if (!agentId || typeof agentId !== 'string') return { error: 'Invalid agent' };
    const presets = { ...store.get('agentPresets', {}) };
    const trimmed = String(args || '').trim();
    if (trimmed) presets[agentId] = { args: trimmed };
    else delete presets[agentId]; // empty = fall back to the bare command
    store.set('agentPresets', presets);
    return { ok: true, presets };
  });

  // Saved Launch Targets live on the Site record, so they travel with it and
  // are reclaimed when the Site is deleted. Shape: { id, agentId, label, cwd,
  // args }. `cwd` may be webroot-relative or absolute; `args: null` inherits the
  // Agent's global default.
  ipcMain.handle('agent-targets-list', (_e, siteId) => {
    const site = findSite(siteId);
    return site?.launchTargets || [];
  });

  ipcMain.handle('agent-target-save', (_e, siteId, target) => {
    const sites = store.get('sites', []);
    const site = sites.find((s) => s.id === siteId);
    if (!site) return { error: 'Site not found' };
    if (!target?.agentId) return { error: 'An agent is required' };
    const cwd = String(target.cwd || '').trim();
    if (!cwd) return { error: 'A directory is required' };

    const clean = {
      id: target.id || crypto.randomUUID(),
      agentId: target.agentId,
      label: String(target.label || '').trim(),
      cwd,
      // Empty string means "no override" → inherit the global default (null).
      args: String(target.args || '').trim() || null,
    };

    const list = site.launchTargets || [];
    const idx = list.findIndex((t) => t.id === clean.id);
    site.launchTargets =
      idx >= 0 ? list.map((t) => (t.id === clean.id ? clean : t)) : [...list, clean];
    store.set('sites', sites);
    return { ok: true, target: clean, targets: site.launchTargets };
  });

  ipcMain.handle('agent-target-delete', (_e, siteId, targetId) => {
    const sites = store.get('sites', []);
    const site = sites.find((s) => s.id === siteId);
    if (!site) return { error: 'Site not found' };
    site.launchTargets = (site.launchTargets || []).filter((t) => t.id !== targetId);
    store.set('sites', sites);
    return { ok: true, targets: site.launchTargets };
  });

  // The embedded terminal calls this once xterm is mounted; bind the sender's
  // window to the Session and replay the ring buffer (Q9).
  ipcMain.handle('terminal-ready', (event, sessionId) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { error: 'no window' };
    return agents.attach(sessionId, win);
  });

  ipcMain.on('terminal-input', (_e, sessionId, data) => agents.write(sessionId, data));
  ipcMain.on('terminal-resize', (_e, sessionId, cols, rows) =>
    agents.resize(sessionId, cols, rows)
  );
  ipcMain.on('terminal-clear', (_e, sessionId) => agents.clearBuffer(sessionId));
  ipcMain.handle('terminal-stop', (_e, sessionId) => {
    agents.stop(sessionId);
    return { ok: true };
  });

  // ─── In-app browser ───────────────────────────────────────────────────
  // The renderer owns the <webview> element and re-registers its guest on
  // every dom-ready (reparenting mints a new webContentsId); these handlers
  // reach the guest for the things a renderer cannot do itself.

  ipcMain.handle('browser-register', (_e, tabKey, webContentsId) => {
    browser.register(tabKey, webContentsId);
    return { ok: true };
  });

  ipcMain.handle('browser-unregister', (_e, tabKey) => {
    browser.unregister(tabKey);
    return { ok: true };
  });

  ipcMain.handle('browser-navigate', (_e, tabKey, url) => ({
    ok: browser.navigate(tabKey, url),
  }));

  ipcMain.handle('browser-reload', (_e, tabKey, hard) => ({
    ok: browser.reload(tabKey, !!hard),
  }));

  ipcMain.handle('browser-open-devtools', (_e, tabKey) => ({
    ok: browser.openDevTools(tabKey),
  }));

  // Address-bar autocomplete, backed by the JsonStore rather than a SQL layer.
  ipcMain.handle('browser-history-record', (_e, visit) => {
    browserHistory.record(store, visit || {});
    return { ok: true };
  });

  ipcMain.handle('browser-history-search', (_e, query, limit) =>
    browserHistory.search(store, query, limit)
  );

  ipcMain.handle('browser-history-clear', () => {
    browserHistory.clear(store);
    return { ok: true };
  });

  // Cookies, cache and site storage for the browser's partition. Wiping it logs
  // the user out of every site they signed into in-app, so the UI confirms.
  ipcMain.handle('browser-clear-data', async () => {
    try {
      const ses = session.fromPartition(browser.PARTITION);
      await ses.clearStorageData();
      await ses.clearCache();
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  // Project explorer: read-only directory listing confined to a Site's root.
  ipcMain.handle('list-directory', (_e, rootPath, dirPath) => {
    try {
      return { ok: true, entries: files.listDirectory(rootPath, dirPath) };
    } catch (err) {
      return { error: err.message };
    }
  });

  // Validate a candidate path from terminal output for the file-link provider
  // (confined to the site root; never throws).
  ipcMain.handle('terminal-stat-path', (_e, rootPath, candidate) =>
    files.statPath(rootPath, candidate)
  );

  // Open a file in the user's configured editor, falling back to the OS
  // default when none is set or the chosen one isn't installed.
  ipcMain.handle('open-file-path', (_e, filePath) => {
    return externalTools.openInEditor(
      filePath,
      {
        editor: settings.get('tools.editor'),
        customCommand: settings.get('tools.editorCustomCommand'),
      },
      (p) => shell.openPath(p)
    );
  });

  // Editors/terminals installed on this machine, for the settings pickers.
  ipcMain.handle('list-external-tools', () => externalTools.listTools());

  // Read a text file for the in-app code editor (confined to the site root).
  ipcMain.handle('read-file', (_e, rootPath, filePath) => {
    try {
      return { ok: true, ...files.readFile(rootPath, filePath) };
    } catch (err) {
      return { error: err.message };
    }
  });

  // Write edited file contents back to disk (confined to the site root).
  ipcMain.handle('write-file', (_e, rootPath, filePath, content) => {
    try {
      return { ok: true, ...files.writeFile(rootPath, filePath, content) };
    } catch (err) {
      return { error: err.message };
    }
  });

  // Reveal a file/folder in Finder (confined to the site root).
  ipcMain.handle('reveal-in-finder', (_e, rootPath, targetPath) => {
    try {
      const { resolved } = files.assertInRoot(rootPath, targetPath);
      shell.showItemInFolder(resolved);
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  // Create a new empty file inside a directory.
  ipcMain.handle('create-file', (_e, rootPath, dirPath, name) => {
    try {
      return { ok: true, ...files.createFile(rootPath, dirPath, name) };
    } catch (err) {
      return { error: err.message };
    }
  });

  // Create a new folder inside a directory.
  ipcMain.handle('create-folder', (_e, rootPath, dirPath, name) => {
    try {
      return { ok: true, ...files.createFolder(rootPath, dirPath, name) };
    } catch (err) {
      return { error: err.message };
    }
  });

  // Rename a file/folder in place.
  ipcMain.handle('rename-path', (_e, rootPath, targetPath, newName) => {
    try {
      return { ok: true, ...files.renamePath(rootPath, targetPath, newName) };
    } catch (err) {
      return { error: err.message };
    }
  });

  // Import files/folders dropped from Finder into a directory under the site
  // root (confined; never overwrites).
  ipcMain.handle('import-files', (_e, rootPath, dirPath, sourcePaths) => {
    try {
      return { ok: true, ...files.importFiles(rootPath, dirPath, sourcePaths) };
    } catch (err) {
      return { error: err.message };
    }
  });

  // Read-only git status for the explorer's Changes tab (source control view).
  ipcMain.handle('git-status', async (_e, rootPath) => {
    try {
      return { ok: true, ...(await git.gitStatus(rootPath)) };
    } catch (err) {
      return { error: err.message };
    }
  });

  // Read a file's contents at a git revision (HEAD or index) for the diff
  // viewer. Read-only; git runs in `repoRoot` (which may be a nested repo),
  // confined to the site root by an assertInRoot guard plus a rel path check.
  ipcMain.handle('git-file-at', async (_e, siteRoot, repoRoot, rel, rev) => {
    try {
      files.assertInRoot(siteRoot, repoRoot);
      return { ok: true, ...(await git.fileAt(repoRoot, rel, rev)) };
    } catch (err) {
      return { error: err.message };
    }
  });

  // Stage / unstage changed paths from the Changes tab (git add / restore),
  // targeting the specific repo the files belong to.
  ipcMain.handle('git-stage', async (_e, siteRoot, repoRoot, rels) => {
    try {
      files.assertInRoot(siteRoot, repoRoot);
      return await git.stage(repoRoot, rels);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('git-unstage', async (_e, siteRoot, repoRoot, rels) => {
    try {
      files.assertInRoot(siteRoot, repoRoot);
      return await git.unstage(repoRoot, rels);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Discard a file's unstaged changes in `repoRoot`. Tracked files are reverted
  // with git restore; untracked files are moved to the Trash (confined to the
  // site root) — never `git clean`, so it's recoverable.
  ipcMain.handle('git-discard', async (_e, siteRoot, repoRoot, rel, status) => {
    try {
      files.assertInRoot(siteRoot, repoRoot);
      if (status === '?') {
        const abs = path.join(path.resolve(repoRoot), rel);
        const { root, resolved } = files.assertInRoot(siteRoot, abs);
        if (resolved === root) throw new Error('Invalid path');
        await shell.trashItem(resolved);
        return { ok: true };
      }
      return await git.discardTracked(repoRoot, rel);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Move a file/folder to the system Trash (confined to the site root).
  ipcMain.handle('trash-path', async (_e, rootPath, targetPath) => {
    try {
      const { root, resolved } = files.assertInRoot(rootPath, targetPath);
      if (resolved === root) throw new Error('Cannot delete the site root');
      await shell.trashItem(resolved);
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  // Heal per-site vhosts shortly after startup: regenerate each from the
  // current template and rewrite only the ones that differ (e.g. sites created
  // before client_max_body_size / PHP_VALUE support), then reload nginx once.
  setTimeout(() => {
    try {
      const sites = store.get('sites', []);
      const serversDir = nginx.getServersDir();
      if (!serversDir || !fs.existsSync(serversDir)) return;
      let changed = false;
      for (const site of sites) {
        try {
          const desired = nginx.generateSiteConfig(site);
          const confPath = path.join(serversDir, `${site.domain}.conf`);
          const current = fs.existsSync(confPath)
            ? fs.readFileSync(confPath, 'utf8')
            : null;
          if (current !== desired) {
            fs.writeFileSync(confPath, desired, 'utf8');
            changed = true;
          }
        } catch {}
      }
      if (changed) {
        try {
          nginx.reload();
        } catch {}
      }
    } catch {}
  }, 3000);

  // Re-apply the Mailpit sendmail override shortly after startup so PHP
  // versions installed since the toggle was enabled also route mail() into
  // Mailpit. Idempotent — only rewrites/reloads when something differs.
  setTimeout(() => {
    try {
      if (settings.get('mail.catch') && mailpit.isInstalled()) {
        mailpit.setCatchEnabled(true);
      }
    } catch {}
  }, 4000);

  // When the user returns to the app (e.g. after `brew install`-ing something
  // in a terminal), re-check dependencies and service status automatically —
  // no manual refresh needed. Both are non-blocking and rate-limited.
  if (win) {
    win.on('focus', () => {
      refreshDependencies(win);
      refreshServiceStatus().then(() => {
        if (win && !win.isDestroyed() && win.webContents) {
          win.webContents.send('service-status-update', getServiceStatus());
        }
      });
    });
  }

  // ─── Sites ───────────────────────────────────────────────────────────

  ipcMain.handle('get-sites', () => {
    const sites = store.get('sites', []);

    // Heal sites whose stored wpVersion is malformed (older builds captured
    // WP-CLI's PHP deprecation output into this field). Re-probe just those and
    // persist the cleaned value so the UI stops showing the warning text.
    let changed = false;
    const healed = sites.map((site) => {
      const v = site.wpVersion;
      if (v && v !== 'unknown' && !/^\d+\.\d+(?:\.\d+)*$/.test(v)) {
        const fresh = wordpress.getSiteWordPressVersion(site.path);
        changed = true;
        return { ...site, wpVersion: fresh || 'unknown' };
      }
      return site;
    });
    if (changed) store.set('sites', healed);
    return healed;
  });

  ipcMain.handle('add-site', async (event, siteData) => {
    try {
      const progress = (data) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('site-create-progress', data);
        }
      };

      // Authoritative input validation (renderer validation is advisory only).
      const { valid, errors } = validation.validateSiteInput(siteData);
      if (!valid) {
        return { success: false, error: errors.join(' ') };
      }

      // Validate domain uniqueness
      const sites = store.get('sites', []);
      if (sites.some((s) => s.domain === siteData.domain)) {
        return { success: false, error: `Domain ${siteData.domain} already exists` };
      }

      // Reject a directory that already contains a WordPress install so we
      // don't clobber existing files.
      if (fs.existsSync(path.join(siteData.path, 'wp-config.php'))) {
        return {
          success: false,
          error: `${siteData.path} already contains a WordPress install.`,
        };
      }

      // Ensure MySQL is running
      if (!mysql.isRunning()) {
        return {
          success: false,
          error: 'MySQL is not running. Start it in the Services panel.',
        };
      }

      let site = await wordpress.createWordPressSite(siteData, progress);

      // Optional HTTPS-on-create (Settings → Sites). Best-effort: a failure to
      // mint a certificate must not lose a site that was otherwise created, so
      // it degrades to plain HTTP with the reason surfaced in the progress log.
      if (siteData.https) {
        try {
          progress({ message: 'Enabling HTTPS…' });
          site = applyHttps(site, true);
        } catch (err) {
          progress({ message: `HTTPS setup failed (${humanize(err)}); serving HTTP.` });
        }
      }

      const updatedSites = [...sites, site];
      store.set('sites', updatedSites);

      return { success: true, site };
    } catch (err) {
      console.error('add-site error:', err);
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('remove-site', async (_, id, opts = {}) => {
    try {
      const sites = store.get('sites', []);
      const site = sites.find((s) => s.id === id);
      if (!site) return { success: false, error: 'Site not found' };

      // Tear down any live share tunnel before removing the vhost/files.
      cloudflared.stopTunnel(id);

      wordpress.removeWordPressSite(site, opts);

      store.set(
        'sites',
        sites.filter((s) => s.id !== id)
      );
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('set-site-https', async (_, id, enabled) => {
    try {
      const sites = store.get('sites', []);
      const idx = sites.findIndex((s) => s.id === id);
      if (idx === -1) return { success: false, error: 'Site not found' };

      // Switching scheme rewrites the vhost; drop any live tunnel first so its
      // server_name alias isn't silently lost (the user can re-share after).
      cloudflared.stopTunnel(id);

      const updated = applyHttps(sites[idx], enabled);
      sites[idx] = updated;
      store.set('sites', sites);
      return { success: true, site: updated };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  // ─── Export / Import ─────────────────────────────────────────────────

  ipcMain.handle('export-site', async (event, id) => {
    try {
      const site = store.get('sites', []).find((s) => s.id === id);
      if (!site) return { success: false, error: 'Site not found' };
      if (!mysql.isRunning()) {
        return {
          success: false,
          error: 'MySQL is not running. Start it in the Services panel.',
        };
      }

      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: path.join(
          os.homedir(),
          'Desktop',
          `${wordpress.sanitizeDomain(site.name) || site.domain}-export.zip`
        ),
        filters: [{ name: 'Zip archive', extensions: ['zip'] }],
      });
      if (result.canceled || !result.filePath) {
        return { success: true, canceled: true };
      }

      const progress = (data) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('site-export-progress', data);
        }
      };
      const { sizeBytes } = await siteops.exportSite(site, result.filePath, progress);
      return { success: true, filePath: result.filePath, sizeBytes };
    } catch (err) {
      console.error('export-site error:', err);
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('select-import-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Site archives', extensions: ['zip', 'wpress'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('inspect-import-archive', async (_, archivePath) => {
    try {
      if (typeof archivePath !== 'string' || !path.isAbsolute(archivePath)) {
        return { success: false, error: 'Invalid archive path.' };
      }
      const info = await siteops.inspectArchive(archivePath);
      return { success: true, ...info };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('import-site', async (event, payload = {}) => {
    try {
      const { archivePath, ...target } = payload;
      if (typeof archivePath !== 'string' || !fs.existsSync(archivePath)) {
        return { success: false, error: 'The selected archive no longer exists.' };
      }

      // Same authoritative validation as add-site (admin fields don't apply —
      // the imported database carries its own users).
      const { valid, errors } = validation.validateSiteInput({
        ...target,
        adminUser: 'admin',
        adminPassword: 'imported',
        adminEmail: `admin@${target.domain}`,
      });
      if (!valid) return { success: false, error: errors.join(' ') };

      const sites = store.get('sites', []);
      if (sites.some((s) => s.domain === target.domain)) {
        return { success: false, error: `Domain ${target.domain} already exists` };
      }
      if (sites.some((s) => s.dbName === target.dbName)) {
        return { success: false, error: `Database ${target.dbName} already exists` };
      }
      if (mysql.databaseExists(target.dbName)) {
        return {
          success: false,
          error: `A database named ${target.dbName} already exists in MySQL.`,
        };
      }
      if (nginx.siteConfigExists(target.domain)) {
        return {
          success: false,
          error: `An nginx config for ${target.domain} already exists.`,
        };
      }
      if (fs.existsSync(path.join(target.path, 'wp-config.php'))) {
        return {
          success: false,
          error: `${target.path} already contains a WordPress install.`,
        };
      }
      if (!mysql.isRunning()) {
        return {
          success: false,
          error: 'MySQL is not running. Start it in the Services panel.',
        };
      }

      const progress = (data) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('site-import-progress', data);
        }
      };
      const site = await siteops.importSite(archivePath, target, progress);

      store.set('sites', [...store.get('sites', []), site]);
      return { success: true, site };
    } catch (err) {
      console.error('import-site error:', err);
      return { success: false, error: humanize(err) };
    }
  });

  // ─── Clone / Change URL / CA status ──────────────────────────────────

  ipcMain.handle('clone-site', async (event, id, target = {}) => {
    try {
      const source = store.get('sites', []).find((s) => s.id === id);
      if (!source) return { success: false, error: 'Source site not found' };
      if (!mysql.isRunning()) {
        return {
          success: false,
          error: 'MySQL is not running. Start it in the Services panel.',
        };
      }

      // Same authoritative validation + uniqueness checks as import.
      const { valid, errors } = validation.validateSiteInput({
        ...target,
        adminUser: 'admin',
        adminPassword: 'cloned',
        adminEmail: `admin@${target.domain}`,
      });
      if (!valid) return { success: false, error: errors.join(' ') };

      const sites = store.get('sites', []);
      if (sites.some((s) => s.domain === target.domain)) {
        return { success: false, error: `Domain ${target.domain} already exists` };
      }
      if (sites.some((s) => s.dbName === target.dbName)) {
        return { success: false, error: `Database ${target.dbName} already exists` };
      }
      if (mysql.databaseExists(target.dbName)) {
        return {
          success: false,
          error: `A database named ${target.dbName} already exists in MySQL.`,
        };
      }
      if (nginx.siteConfigExists(target.domain)) {
        return {
          success: false,
          error: `An nginx config for ${target.domain} already exists.`,
        };
      }
      if (fs.existsSync(target.path) && fs.readdirSync(target.path).length > 0) {
        return {
          success: false,
          error: `${target.path} already exists and is not empty.`,
        };
      }

      const progress = (data) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('site-clone-progress', data);
        }
      };
      const site = await siteops.cloneSite(source, target, progress);

      store.set('sites', [...store.get('sites', []), site]);
      return { success: true, site };
    } catch (err) {
      console.error('clone-site error:', err);
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('change-site-url', async (event, id, newDomain) => {
    try {
      const sites = store.get('sites', []);
      const idx = sites.findIndex((s) => s.id === id);
      if (idx === -1) return { success: false, error: 'Site not found' };
      const site = sites[idx];

      if (typeof newDomain !== 'string' || !validation.DOMAIN_RE.test(newDomain)) {
        return {
          success: false,
          error: 'Please enter a valid domain (e.g. mysite.test).',
        };
      }
      if (newDomain === site.domain) {
        return { success: false, error: 'That is already the site’s domain.' };
      }
      if (sites.some((s) => s.id !== id && s.domain === newDomain)) {
        return { success: false, error: `Domain ${newDomain} already exists` };
      }
      if (nginx.siteConfigExists(newDomain)) {
        return {
          success: false,
          error: `An nginx config for ${newDomain} already exists.`,
        };
      }
      if (!mysql.isRunning()) {
        return {
          success: false,
          error: 'MySQL is not running. Start it in the Services panel.',
        };
      }

      // Drop any live tunnel first — its server_name alias points at the old
      // domain and would be orphaned by the rename.
      cloudflared.stopTunnel(id);

      const progress = (data) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('site-changeurl-progress', data);
        }
      };
      const patch = await siteops.changeSiteUrl(site, newDomain, progress);

      const updated = { ...site, ...patch };
      sites[idx] = updated;
      store.set('sites', sites);
      return { success: true, site: updated };
    } catch (err) {
      console.error('change-site-url error:', err);
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('get-ca-status', async () => {
    try {
      return { success: true, ...mkcert.getCaStatus() };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  // ─── Blueprints ──────────────────────────────────────────────────────

  ipcMain.handle('get-blueprints', async () => {
    try {
      return { success: true, blueprints: blueprints.listBlueprints(store) };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('save-blueprint', async (event, id, opts = {}) => {
    try {
      const site = store.get('sites', []).find((s) => s.id === id);
      if (!site) return { success: false, error: 'Site not found' };
      if (!mysql.isRunning()) {
        return {
          success: false,
          error: 'MySQL is not running. Start it in the Services panel.',
        };
      }
      const progress = (data) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('blueprint-save-progress', data);
        }
      };
      const blueprint = await blueprints.saveBlueprint(
        store,
        { site, name: opts.name, description: opts.description },
        progress
      );
      return { success: true, blueprint };
    } catch (err) {
      console.error('save-blueprint error:', err);
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('delete-blueprint', async (_, id) => {
    try {
      blueprints.deleteBlueprint(store, id);
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('create-site-from-blueprint', async (event, payload = {}) => {
    try {
      const { blueprintId, ...target } = payload;
      const bp = blueprints.listBlueprints(store).find((b) => b.id === blueprintId);
      if (!bp) return { success: false, error: 'That blueprint no longer exists.' };

      // Same authoritative validation + uniqueness checks as import (the
      // blueprint's database carries its own users, so admin fields are stubs).
      const { valid, errors } = validation.validateSiteInput({
        ...target,
        adminUser: 'admin',
        adminPassword: 'blueprint',
        adminEmail: `admin@${target.domain}`,
      });
      if (!valid) return { success: false, error: errors.join(' ') };

      const sites = store.get('sites', []);
      if (sites.some((s) => s.domain === target.domain)) {
        return { success: false, error: `Domain ${target.domain} already exists` };
      }
      if (sites.some((s) => s.dbName === target.dbName)) {
        return { success: false, error: `Database ${target.dbName} already exists` };
      }
      if (mysql.databaseExists(target.dbName)) {
        return {
          success: false,
          error: `A database named ${target.dbName} already exists in MySQL.`,
        };
      }
      if (nginx.siteConfigExists(target.domain)) {
        return {
          success: false,
          error: `An nginx config for ${target.domain} already exists.`,
        };
      }
      if (fs.existsSync(path.join(target.path, 'wp-config.php'))) {
        return {
          success: false,
          error: `${target.path} already contains a WordPress install.`,
        };
      }
      if (!mysql.isRunning()) {
        return {
          success: false,
          error: 'MySQL is not running. Start it in the Services panel.',
        };
      }

      // Reuse the add-site progress channel so AddSiteModal's existing listener
      // shows blueprint progress unchanged.
      const progress = (data) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('site-create-progress', data);
        }
      };
      const site = await blueprints.createSiteFromBlueprint(
        store,
        blueprintId,
        target,
        progress
      );

      store.set('sites', [...store.get('sites', []), site]);
      return { success: true, site };
    } catch (err) {
      console.error('create-site-from-blueprint error:', err);
      return { success: false, error: humanize(err) };
    }
  });

  // ─── One-Click Admin (magic login) ─────────────────────────────────────

  // Lists the site's administrator accounts for the account picker.
  ipcMain.handle('list-admin-users', async (_, id) => {
    try {
      const site = findSite(id);
      if (!site) return { success: false, error: 'Site not found' };
      const users = wordpress.listAdminUsers(site.path);
      return { success: true, users };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  // Enables/disables one-click admin for a site and records the chosen user.
  // The per-site secret lives outside the site record (so it's never shipped to
  // the renderer via get-sites); the site record only carries the enabled flag
  // and selected user id.
  ipcMain.handle('set-one-click-admin', async (_, id, { enabled, userId } = {}) => {
    try {
      const sites = store.get('sites', []);
      const idx = sites.findIndex((s) => s.id === id);
      if (idx === -1) return { success: false, error: 'Site not found' };
      const site = sites[idx];

      let updated;
      if (enabled) {
        const uid = parseInt(userId, 10);
        if (!Number.isInteger(uid) || uid <= 0) {
          return { success: false, error: 'Select an administrator to log in as.' };
        }
        let secret = store.get(`magicLogin.${id}`, null);
        if (!secret) {
          secret = crypto.randomBytes(24).toString('hex');
          store.set(`magicLogin.${id}`, secret);
        }
        wordpress.ensureMagicLoginMuPlugin(site.path, { userId: uid, secret });
        updated = { ...site, oneClickAdmin: { enabled: true, userId: uid } };
      } else {
        wordpress.removeMagicLoginMuPlugin(site.path);
        updated = {
          ...site,
          oneClickAdmin: { ...(site.oneClickAdmin || {}), enabled: false },
        };
      }

      sites[idx] = updated;
      store.set('sites', sites);
      return { success: true, site: updated };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  // Opens wp-admin — via the magic-login URL when one-click admin is enabled,
  // otherwise the plain /wp-admin. Kept in the main process so the secret is
  // never handed to the renderer.
  // wp-admin for a site, upgraded to a magic-login link when one-click admin is
  // on. Shared so an in-app browser tab lands signed in just like the system
  // browser does.
  function resolveWpAdminUrl(id) {
    const site = store.get('sites', []).find((s) => s.id === id);
    if (!site) return { success: false, error: 'Site not found' };
    const base = site.url.replace(/\/+$/, '');
    let url = `${base}/wp-admin`;
    if (site.oneClickAdmin?.enabled) {
      const secret = store.get(`magicLogin.${id}`, null);
      if (secret) url = `${base}/?wpxen_magic_login=${secret}`;
    }
    return { success: true, url };
  }

  ipcMain.handle('get-wp-admin-url', (_, id) => resolveWpAdminUrl(id));

  // ─── Site config (WP Config Manager) ───────────────────────────────────

  function findSite(id) {
    return store.get('sites', []).find((s) => s.id === id) || null;
  }

  ipcMain.handle('get-wp-config', async (_, id) => {
    try {
      const site = findSite(id);
      if (!site) return { success: false, error: 'Site not found' };
      return {
        success: true,
        schema: wordpress.getWpConfigSchema(),
        values: wordpress.getWpConfig(site.path),
      };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('set-wp-config', async (_, id, changes) => {
    try {
      const site = findSite(id);
      if (!site) return { success: false, error: 'Site not found' };
      wordpress.setWpConfig(site.path, changes || {});
      return { success: true, values: wordpress.getWpConfig(site.path) };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('get-wp-config-raw', async (_, id) => {
    try {
      const site = findSite(id);
      if (!site) return { success: false, error: 'Site not found' };
      return { success: true, contents: wordpress.getWpConfigRaw(site.path) };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('save-wp-config-raw', async (_, id, contents) => {
    try {
      const site = findSite(id);
      if (!site) return { success: false, error: 'Site not found' };
      wordpress.saveWpConfigRaw(site.path, contents);
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  // ─── WordPress overview / updates ──────────────────────────────────────

  ipcMain.handle('get-wp-overview', async (_, id) => {
    try {
      const site = findSite(id);
      if (!site) return { success: false, error: 'Site not found' };
      return { success: true, overview: await wordpress.getWpOverview(site.path) };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('update-wp-core', async (_, id) => {
    try {
      const site = findSite(id);
      if (!site) return { success: false, error: 'Site not found' };
      await wordpress.updateWpCore(site.path);

      // Persist the fresh core version so the site card badge stays accurate.
      const fresh = wordpress.getSiteWordPressVersion(site.path);
      if (fresh) {
        const sites = store.get('sites', []);
        const idx = sites.findIndex((s) => s.id === id);
        if (idx !== -1) {
          sites[idx] = { ...sites[idx], wpVersion: fresh };
          store.set('sites', sites);
        }
      }
      return { success: true, wpVersion: fresh };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('update-wp-item', async (_, id, type, name) => {
    try {
      const site = findSite(id);
      if (!site) return { success: false, error: 'Site not found' };
      await wordpress.updateWpItem(site.path, type, name);
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('update-wp-all', async (_, id) => {
    try {
      const site = findSite(id);
      if (!site) return { success: false, error: 'Site not found' };
      await wordpress.updateWpAll(site.path);
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  // ─── Plugin management ─────────────────────────────────────────────────

  ipcMain.handle('get-wp-plugins', async (_, id) => {
    try {
      const site = findSite(id);
      if (!site) return { success: false, error: 'Site not found' };
      return { success: true, plugins: await wordpress.listPlugins(site.path) };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  // Runs a lifecycle action (activate/deactivate/update/delete) on one or more
  // plugins sequentially, collecting per-plugin failures instead of aborting.
  ipcMain.handle('wp-plugin-action', async (_, id, action, names) => {
    try {
      const site = findSite(id);
      if (!site) return { success: false, error: 'Site not found' };
      const list = Array.isArray(names) ? names : [names];
      const errors = [];
      for (const name of list) {
        try {
          await wordpress.pluginAction(site.path, action, name);
        } catch (err) {
          errors.push(`${name}: ${humanize(err)}`);
        }
      }
      if (errors.length > 0) {
        return { success: false, error: errors.join(' — ') };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('wp-plugin-auto-update', async (_, id, name, enabled) => {
    try {
      const site = findSite(id);
      if (!site) return { success: false, error: 'Site not found' };
      await wordpress.setPluginAutoUpdate(site.path, name, !!enabled);
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('wp-plugin-install', async (_, id, slug, activate) => {
    try {
      const site = findSite(id);
      if (!site) return { success: false, error: 'Site not found' };
      await wordpress.installPlugin(site.path, slug, !!activate);
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  // ─── Theme management ──────────────────────────────────────────────────

  ipcMain.handle('get-wp-themes', async (_, id) => {
    try {
      const site = findSite(id);
      if (!site) return { success: false, error: 'Site not found' };
      return { success: true, themes: await wordpress.listThemes(site.path) };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('wp-theme-action', async (_, id, action, names) => {
    try {
      const site = findSite(id);
      if (!site) return { success: false, error: 'Site not found' };
      const list = Array.isArray(names) ? names : [names];
      const errors = [];
      for (const name of list) {
        try {
          await wordpress.themeAction(site.path, action, name);
        } catch (err) {
          errors.push(`${name}: ${humanize(err)}`);
        }
      }
      if (errors.length > 0) {
        return { success: false, error: errors.join(' — ') };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('wp-theme-auto-update', async (_, id, name, enabled) => {
    try {
      const site = findSite(id);
      if (!site) return { success: false, error: 'Site not found' };
      await wordpress.setThemeAutoUpdate(site.path, name, !!enabled);
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('wp-theme-install', async (_, id, slug, activate) => {
    try {
      const site = findSite(id);
      if (!site) return { success: false, error: 'Site not found' };
      await wordpress.installTheme(site.path, slug, !!activate);
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  // ─── Site logs ─────────────────────────────────────────────────────────

  ipcMain.handle('get-site-log', async (_, id, kind) => {
    try {
      const site = findSite(id);
      if (!site) return { success: false, error: 'Site not found' };
      return { success: true, log: logs.readLog(site, kind) };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('clear-site-log', async (_, id, kind) => {
    try {
      const site = findSite(id);
      if (!site) return { success: false, error: 'Site not found' };
      logs.clearLog(site, kind);
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('save-site-log', async (_, id, kind) => {
    try {
      const site = findSite(id);
      if (!site) return { success: false, error: 'Site not found' };
      const src = logs.resolveLogPath(site, kind);
      if (!fs.existsSync(src)) {
        return { success: false, error: 'The log file does not exist yet.' };
      }
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: path.join(os.homedir(), 'Downloads', `${site.domain}-${kind}.log`),
      });
      if (result.canceled || !result.filePath) {
        return { success: true, canceled: true };
      }
      fs.copyFileSync(src, result.filePath);
      return { success: true, path: result.filePath };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  // ─── Site PHP settings ─────────────────────────────────────────────────

  ipcMain.handle('get-site-php', async (_, id) => {
    try {
      const site = findSite(id);
      if (!site) return { success: false, error: 'Site not found' };

      const schema = phpService.getSitePhpSettingsSchema();
      // Baseline = the global PHP configuration for this site's version. A site
      // without saved overrides shows (and keeps following) the global values.
      const globals = phpService.getGlobalSitePhpValues(site.phpVersion);

      return {
        success: true,
        schema,
        values: { ...globals, ...(site.phpSettings || {}) },
        globals,
        customized: Object.keys(site.phpSettings || {}),
        phpVersion: site.phpVersion,
        installedVersions: brew.getInstalledPhpVersions(),
      };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('set-site-php', async (_, id, payload = {}) => {
    try {
      const sites = store.get('sites', []);
      const idx = sites.findIndex((s) => s.id === id);
      if (idx === -1) return { success: false, error: 'Site not found' };
      const site = sites[idx];

      // Validate the PHP version (must be an installed major.minor).
      let phpVersion = site.phpVersion;
      if (payload.phpVersion != null) {
        if (
          !/^\d+\.\d+$/.test(String(payload.phpVersion)) ||
          !brew.getInstalledPhpVersions().includes(payload.phpVersion)
        ) {
          return { success: false, error: 'Selected PHP version is not installed.' };
        }
        phpVersion = payload.phpVersion;
      }

      // Validate the ini overrides (throws a human message on bad input), then
      // keep only the values that actually differ from the global configuration
      // — fields left at the global value keep inheriting it, and a site with
      // no differences carries no PHP_VALUE block at all.
      const requested = phpService.validateSitePhpSettings(payload.settings || {});
      const globals = phpService.getGlobalSitePhpValues(phpVersion);
      const phpSettings = {};
      for (const [key, value] of Object.entries(requested)) {
        if (value !== globals[key]) phpSettings[key] = value;
      }

      // The vhost is about to be rewritten — drop any live share tunnel so its
      // transient server_name alias isn't silently lost.
      cloudflared.stopTunnel(id);

      const updated = { ...site, phpVersion, phpSettings };
      nginx.createSiteConfig(updated);
      nginx.reload();

      sites[idx] = updated;
      store.set('sites', sites);
      return { success: true, site: updated };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  // Install (first run only), configure and serve phpMyAdmin, then hand back
  // the deep link for `dbName`. The renderer decides where it opens — the
  // default browser or an in-app tab — via Settings → Open links in.
  async function resolvePhpMyAdminUrl(dbName) {
    // Reject anything that isn't a valid DB name before it reaches the URL —
    // same rule that gates site creation.
    if (dbName != null && !validation.DB_NAME_RE.test(dbName)) {
      return { success: false, error: 'Invalid database name.' };
    }
    await phpmyadmin.ensureReady();
    return { success: true, url: phpmyadmin.getUrl(dbName) };
  }

  ipcMain.handle('get-phpmyadmin-url', async (_, dbName) => {
    try {
      return await resolvePhpMyAdminUrl(dbName);
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  // The Mailpit inbox, for opening in an in-app browser tab.
  ipcMain.handle('get-mailpit-url', () => {
    if (!mailpit.isInstalled()) {
      return { success: false, error: 'Mailpit is not installed.' };
    }
    return { success: true, url: mailpit.getUrl() };
  });

  // ─── Mailpit (email catching) ──────────────────────────────────────────

  ipcMain.handle('get-mailpit-status', async () => {
    const installed = mailpit.isInstalled();
    return {
      installed,
      running: installed ? await mailpit.isRunningAsync() : false,
      catching: !!settings.get('mail.catch'),
      url: mailpit.getUrl(),
    };
  });

  ipcMain.handle('install-mailpit', async (event) => {
    try {
      await mailpit.install((line) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('mailpit-install-progress', { line });
        }
      });
      brew.invalidateDependencyCache();
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('set-mail-catching', async (_, enabled) => {
    try {
      // Through the schema, not the store directly, so the Settings page and
      // the Mail page never disagree. The 'mail.catch' effect is what writes
      // the sendmail_path override into each PHP version's conf.d.
      const result = settings.write({ 'mail.catch': !!enabled });
      if (!result.ok) {
        return { success: false, error: result.rejected.map((r) => r.reason).join(', ') };
      }
      broadcastSettings(result.settings);
      // Catching without the sink running would black-hole mail — bring it up.
      if (enabled && !(await mailpit.isRunningAsync())) {
        try {
          await mailpit.start();
        } catch {}
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('open-mailpit', async (_, messageId) => {
    try {
      const url = mailpit.getUrl(messageId);
      openExternalSafely(url);
      return { success: true, url };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('get-mail-messages', async (_, opts = {}) => {
    try {
      const data = await mailpit.listMessages(opts);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('get-mail-message', async (_, id) => {
    try {
      const message = await mailpit.getMessage(id);
      return { success: true, message };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('delete-mail-messages', async (_, ids) => {
    try {
      await mailpit.deleteMessages(ids);
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('mark-mail-read', async () => {
    try {
      await mailpit.markAllRead();
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  // ─── Share tunnels (Cloudflare) ────────────────────────────────────────

  ipcMain.handle('check-cloudflared', async () => {
    return { installed: await cloudflared.isInstalledAsync() };
  });

  ipcMain.handle('install-cloudflared', async (event) => {
    try {
      await cloudflared.install((line) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('cloudflared-install-progress', { line });
        }
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('get-tunnels', () => {
    return cloudflared.getAllTunnels();
  });

  ipcMain.handle('start-tunnel', async (_, id) => {
    try {
      const sites = store.get('sites', []);
      const site = sites.find((s) => s.id === id);
      if (!site) return { success: false, error: 'Site not found' };

      const broadcast = (tunnel) => {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
          mainWindow.webContents.send('tunnel-update', tunnel);
        }
      };

      const tunnel = await cloudflared.startTunnel(site, broadcast);
      return { success: true, tunnel };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('stop-tunnel', async (_, id) => {
    try {
      cloudflared.stopTunnel(id);
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('open-in-browser', (_, url) => {
    const ok = openExternalSafely(url);
    return ok
      ? { success: true }
      : { success: false, error: 'Refused to open unsafe URL' };
  });

  ipcMain.handle('open-in-finder', (_, sitePath) => {
    shell.showItemInFolder(sitePath);
    return { success: true };
  });

  // Opens the site folder in the terminal app chosen in Settings → External
  // Tools, falling back to revealing it in Finder if that can't be scripted.
  ipcMain.handle('open-in-terminal', (_, sitePath) => {
    const result = externalTools.openInTerminal(
      sitePath,
      { terminalApp: settings.get('tools.terminalApp') },
      (p) => shell.showItemInFolder(p)
    );
    return result.ok ? { success: true } : { success: false, error: result.error };
  });

  // ─── Services ────────────────────────────────────────────────────────

  ipcMain.handle('get-service-status', async () => {
    // Refresh on demand (non-blocking) so the renderer gets fresh data, then
    // return the updated cache.
    await refreshServiceStatus();
    return getServiceStatus();
  });

  ipcMain.handle('start-services', async () => {
    try {
      const activePhp = brew.getActivePhpVersion();
      await nginx.start();
      if (activePhp) await phpService.startPhpFpm(activePhp);
      await mysql.start();
      dnsmasq.start();
      // Optional service — start it only when installed, and never let a
      // Mailpit hiccup fail the whole "Start All".
      if (mailpit.isInstalled()) {
        try {
          await mailpit.start();
        } catch {}
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('stop-services', async () => {
    try {
      await nginx.stop();
      await phpService.stopAllPhpFpm();
      await mysql.stop();
      dnsmasq.stop();
      if (mailpit.isInstalled()) {
        try {
          await mailpit.stop();
        } catch {}
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('start-service', async (_, name) => {
    try {
      switch (name) {
        case 'nginx':
          await nginx.start();
          break;
        case 'php': {
          const activePhp = brew.getActivePhpVersion();
          if (activePhp) await phpService.startPhpFpm(activePhp);
          break;
        }
        case 'mysql':
          await mysql.start();
          break;
        case 'dnsmasq':
          dnsmasq.start();
          break;
        case 'mailpit':
          await mailpit.start();
          break;
        default:
          return { success: false, error: `Unknown service: ${name}` };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('stop-service', async (_, name) => {
    try {
      switch (name) {
        case 'nginx':
          await nginx.stop();
          break;
        case 'php':
          await phpService.stopAllPhpFpm();
          break;
        case 'mysql':
          await mysql.stop();
          break;
        case 'dnsmasq':
          dnsmasq.stop();
          break;
        case 'mailpit':
          await mailpit.stop();
          break;
        default:
          return { success: false, error: `Unknown service: ${name}` };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  // Opens a supervised service's log file (written by procman) in the default
  // viewer — surfaced in the UI when a service enters the 'failed' state.
  ipcMain.handle('open-service-log', async (_, name) => {
    try {
      if (!['nginx', 'php', 'mysql', 'mailpit'].includes(name)) {
        return { success: false, error: `Unknown service: ${name}` };
      }
      const logPath = procman.getLogPath(name);
      if (!fs.existsSync(logPath)) {
        return { success: false, error: 'No log has been written yet.' };
      }
      shell.openPath(logPath);
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('restart-service', async (_, name) => {
    try {
      switch (name) {
        case 'nginx':
          await nginx.restart();
          break;
        case 'php': {
          const activePhp = brew.getActivePhpVersion();
          if (activePhp) {
            await phpService.stopPhpFpm(activePhp);
            await phpService.startPhpFpm(activePhp);
          }
          break;
        }
        case 'mysql':
          await mysql.restart();
          break;
        case 'dnsmasq':
          dnsmasq.restart();
          break;
        case 'mailpit':
          await mailpit.restart();
          break;
        default:
          return { success: false, error: `Unknown service: ${name}` };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  // ─── PHP ─────────────────────────────────────────────────────────────

  ipcMain.handle('get-php-versions', async () => {
    return phpService.getInstalledPhpVersionsWithDetailsAsync();
  });

  ipcMain.handle('switch-php-version', async (_, version) => {
    try {
      phpService.switchActivePhpVersion(version);
      // If FPM is running another version, swap it to the new one — sites
      // would otherwise silently keep executing on the old version (brew's
      // KeepAlive used to mask that nothing restarted FPM here).
      const running = phpService.getRunningFpmVersion();
      if (running && running !== version) {
        await phpService.startPhpFpm(version);
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('get-php-ini-settings', async () => {
    return phpService.getPhpIniSettings();
  });

  ipcMain.handle('set-php-ini-setting', async (_, version, key, value) => {
    try {
      phpService.setPhpIniSetting(version, key, value);
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('set-php-ini-setting-all', async (_, key, value) => {
    try {
      phpService.setPhpIniSettingAllVersions(key, value);
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('get-installable-php-versions', async () => {
    return phpService.getInstallablePhpVersions();
  });

  ipcMain.handle('install-php-version', async (event, version) => {
    try {
      const progress = (line) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('php-install-progress', { version, line });
        }
      };
      await phpService.installPhpVersion(version, progress);
      // The new version's conf.d starts empty — re-apply the Mailpit sendmail
      // override so its mail() is caught like the others.
      try {
        if (settings.get('mail.catch') && mailpit.isInstalled()) {
          mailpit.setCatchEnabled(true);
        }
      } catch {}
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('update-php-version', async (event, version) => {
    try {
      const progress = (line) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('php-install-progress', { version, line });
        }
      };
      await phpService.updatePhpVersion(version, progress);
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  // ─── Dependencies ────────────────────────────────────────────────────

  ipcMain.handle('check-dependencies', async (_, force = false) => {
    // Cached after first run and computed off the main thread — navigating to
    // Settings no longer fires a cascade of blocking `brew list` calls.
    return brew.checkAllDependenciesAsync(force);
  });

  // ─── First-run onboarding ─────────────────────────────────────────────

  ipcMain.handle('install-core-deps', async (event) => {
    try {
      await setup.installCoreDeps((line) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('core-deps-install-progress', { line });
        }
      });
      // Push fresh deps to the wizard immediately — bypass the focus rate limit.
      await refreshDependencies(win, { minIntervalMs: 0 });
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('open-homebrew-installer', async () => {
    try {
      await setup.openHomebrewInstaller();
      return { success: true, command: setup.HOMEBREW_INSTALL_CMD };
    } catch (err) {
      return {
        success: false,
        error: humanize(err),
        command: setup.HOMEBREW_INSTALL_CMD,
      };
    }
  });

  ipcMain.handle('get-onboarding-state', () => {
    return { complete: store.get('settings.onboardingComplete', false) };
  });

  ipcMain.handle('set-onboarding-complete', () => {
    store.set('settings.onboardingComplete', true);
    return { success: true };
  });

  // ─── Sudoers / Permissions ────────────────────────────────────────────

  ipcMain.handle('check-sudoers', () => {
    return { configured: sudoers.isConfigured(), path: sudoers.SUDOERS_PATH };
  });

  ipcMain.handle('install-sudoers', async () => {
    try {
      sudoers.install();
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('uninstall-sudoers', async () => {
    try {
      sudoers.uninstall();
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('setup-dnsmasq', async () => {
    try {
      dnsmasq.configureDnsmasq();
      dnsmasq.start();
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  // ─── Settings ────────────────────────────────────────────────────────

  // Flat dotted map of every known setting. The renderer's useSettings() hook
  // holds this and re-reads it on 'settings-updated'.
  ipcMain.handle('settings-get-all', () => settings.read());

  // Validated shallow patch. Always resolves — rejections come back on the
  // result so the UI can roll the control back and say why.
  ipcMain.handle('settings-set', (_e, patch) => {
    try {
      const result = settings.write(patch);
      broadcastSettings(result.settings);
      return result;
    } catch (err) {
      return {
        ok: false,
        applied: [],
        rejected: [{ key: '(patch)', reason: humanize(err) }],
      };
    }
  });

  // Deprecated shape kept for one release so nothing breaks mid-refactor.
  // New code should use settings-get-all / settings-set.
  ipcMain.handle('get-settings', () => {
    const all = settings.read();
    return {
      sitesDir: all['sites.dir'],
      defaultPhpVersion: all['php.defaultVersion'],
      startAtLogin: all['app.startAtLogin'],
      dbUser: all['db.user'],
      dbPassword: all['db.password'],
      brewPrefix: brew.getBrewPrefix() || 'Not detected',
    };
  });

  ipcMain.handle('save-settings', async (_, incoming) => {
    const patch = {};
    if (incoming.sitesDir) patch['sites.dir'] = incoming.sitesDir;
    if (incoming.defaultPhpVersion)
      patch['php.defaultVersion'] = incoming.defaultPhpVersion;
    if (typeof incoming.startAtLogin === 'boolean')
      patch['app.startAtLogin'] = incoming.startAtLogin;
    if (typeof incoming.dbUser === 'string') patch['db.user'] = incoming.dbUser;
    if (typeof incoming.dbPassword === 'string')
      patch['db.password'] = incoming.dbPassword;

    const result = settings.write(patch);
    broadcastSettings(result.settings);
    return result.ok
      ? { success: true }
      : {
          success: false,
          error: result.rejected.map((r) => `${r.key}: ${r.reason}`).join(', '),
        };
  });

  // ─── File dialogs ────────────────────────────────────────────────────

  ipcMain.handle('select-folder', async (_e, defaultPath) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: defaultPath || os.homedir(),
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // ─── System info ─────────────────────────────────────────────────────

  ipcMain.handle('get-system-info', () => {
    return {
      platform: process.platform,
      arch: process.arch,
      homeDir: os.homedir(),
      brewPrefix: brew.getBrewPrefix(),
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
    };
  });
}

// Periodically refresh status (non-blocking) and push it to the renderer.
// Uses a setTimeout chain rather than setInterval so a slow probe can never
// stack overlapping runs.
function startStatusPoller(win) {
  async function tick() {
    try {
      await refreshServiceStatus();
      if (win && !win.isDestroyed() && win.webContents) {
        win.webContents.send('service-status-update', getServiceStatus());
      }
    } catch {}
    setTimeout(tick, 5000);
  }
  tick();
}

// Read a setting from the main process (main.cjs uses this for window and quit
// behaviour). Returns undefined before registerHandlers() has bound the store.
function getSetting(key) {
  return settings ? settings.get(key) : undefined;
}

module.exports = { registerHandlers, startStatusPoller, getServiceStatus, getSetting };
