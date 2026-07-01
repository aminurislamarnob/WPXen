'use strict';

const { ipcMain, shell, dialog, app } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');

// Only ever hand these schemes to shell.openExternal — never file:// or a
// custom URL handler that a tampered store could smuggle in.
function openExternalSafely(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      shell.openExternal(url);
      return true;
    }
  } catch {
    // fall through
  }
  return false;
}

const fs = require('fs');
const brew = require('./services/brew.cjs');
const nginx = require('./services/nginx.cjs');
const phpService = require('./services/php.cjs');
const mysql = require('./services/mysql.cjs');
const dnsmasq = require('./services/dnsmasq.cjs');
const wordpress = require('./services/wordpress.cjs');
const mkcert = require('./services/mkcert.cjs');
const sudoers = require('./services/sudoers.cjs');
const validation = require('./services/validation.cjs');
const { humanize } = require('./services/errors.cjs');

let store;
let mainWindow;
let serviceStatusCache = {
  nginx: { running: false, name: 'nginx' },
  php: { running: false, name: 'PHP-FPM', version: null },
  mysql: { running: false, name: 'MySQL' },
  dnsmasq: { running: false, name: 'dnsmasq' },
};

// Synchronous, instant — returns the last computed snapshot. Used by the tray
// and the get-service-status IPC reply so neither blocks on subprocesses.
function getServiceStatus() {
  return serviceStatusCache;
}

// Recomputes the snapshot using non-blocking async probes run in parallel, so
// the main-thread event loop stays free (no macOS spinning-wait cursor).
async function computeServiceStatus() {
  const [nginxRunning, mysqlRunning, dnsmasqRunning, activePhp, phpRunning] =
    await Promise.all([
      nginx.isRunningAsync(),
      mysql.isRunningAsync(),
      dnsmasq.isRunningAsync(),
      brew.getActivePhpVersionAsync(),
      phpService.isPhpFpmRunningAsync(),
    ]);

  serviceStatusCache = {
    nginx: { running: nginxRunning, name: 'nginx' },
    php: { running: phpRunning, name: 'PHP-FPM', version: activePhp },
    mysql: { running: mysqlRunning, name: 'MySQL' },
    dnsmasq: { running: dnsmasqRunning, name: 'dnsmasq' },
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

  // Apply persisted DB credentials so MySQL operations authenticate correctly.
  mysql.setCredentials({
    user: store.get('settings.dbUser', 'root'),
    password: store.get('settings.dbPassword', ''),
  });

  // Populate the status cache once at startup (non-blocking).
  refreshServiceStatus();

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
    return store.get('sites', []);
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

      const site = await wordpress.createWordPressSite(siteData, progress);

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
      const site = sites[idx];

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

      sites[idx] = updated;
      store.set('sites', sites);
      return { success: true, site: updated };
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

  ipcMain.handle('open-in-terminal', (_, sitePath) => {
    // Build the AppleScript with execFile (no shell) and escape the path for
    // the AppleScript string literal; `quoted form of` then shell-escapes it
    // for `cd`. This keeps a path with spaces/quotes from injecting commands.
    if (typeof sitePath !== 'string' || /[\n\r\0]/.test(sitePath)) {
      return { success: false, error: 'Invalid path' };
    }
    const escaped = sitePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = [
      'tell application "Terminal"',
      '  activate',
      `  do script "cd " & quoted form of "${escaped}"`,
      'end tell',
    ].join('\n');
    execFile('osascript', ['-e', script], (err) => {
      if (err) shell.showItemInFolder(sitePath);
    });
    return { success: true };
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
      nginx.start();
      if (activePhp) phpService.startPhpFpm(activePhp);
      mysql.start();
      dnsmasq.start();
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('stop-services', async () => {
    try {
      nginx.stop();
      phpService.stopAllPhpFpm();
      mysql.stop();
      dnsmasq.stop();
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('start-service', async (_, name) => {
    try {
      switch (name) {
        case 'nginx':
          nginx.start();
          break;
        case 'php': {
          const activePhp = brew.getActivePhpVersion();
          if (activePhp) phpService.startPhpFpm(activePhp);
          break;
        }
        case 'mysql':
          mysql.start();
          break;
        case 'dnsmasq':
          dnsmasq.start();
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
          nginx.stop();
          break;
        case 'php':
          phpService.stopAllPhpFpm();
          break;
        case 'mysql':
          mysql.stop();
          break;
        case 'dnsmasq':
          dnsmasq.stop();
          break;
        default:
          return { success: false, error: `Unknown service: ${name}` };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  ipcMain.handle('restart-service', async (_, name) => {
    try {
      switch (name) {
        case 'nginx':
          nginx.restart();
          break;
        case 'php': {
          const activePhp = brew.getActivePhpVersion();
          if (activePhp) {
            phpService.stopPhpFpm(activePhp);
            phpService.startPhpFpm(activePhp);
          }
          break;
        }
        case 'mysql':
          mysql.restart();
          break;
        case 'dnsmasq':
          dnsmasq.restart();
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

  ipcMain.handle('get-settings', () => {
    return {
      sitesDir: store.get('settings.sitesDir', wordpress.DEFAULT_SITES_DIR),
      defaultPhpVersion: store.get(
        'settings.defaultPhpVersion',
        brew.getActivePhpVersion()
      ),
      startAtLogin: store.get('settings.startAtLogin', false),
      dbUser: store.get('settings.dbUser', 'root'),
      dbPassword: store.get('settings.dbPassword', ''),
      brewPrefix: brew.getBrewPrefix() || 'Not detected',
    };
  });

  ipcMain.handle('save-settings', async (_, settings) => {
    try {
      if (settings.sitesDir) store.set('settings.sitesDir', settings.sitesDir);
      if (settings.defaultPhpVersion)
        store.set('settings.defaultPhpVersion', settings.defaultPhpVersion);
      if (typeof settings.startAtLogin === 'boolean') {
        store.set('settings.startAtLogin', settings.startAtLogin);
        app.setLoginItemSettings({ openAtLogin: settings.startAtLogin });
      }
      if (typeof settings.dbUser === 'string')
        store.set('settings.dbUser', settings.dbUser);
      if (typeof settings.dbPassword === 'string')
        store.set('settings.dbPassword', settings.dbPassword);
      // Re-apply credentials immediately so the running session uses them.
      mysql.setCredentials({
        user: store.get('settings.dbUser', 'root'),
        password: store.get('settings.dbPassword', ''),
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  // ─── File dialogs ────────────────────────────────────────────────────

  ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: os.homedir(),
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

module.exports = { registerHandlers, startStatusPoller, getServiceStatus };
