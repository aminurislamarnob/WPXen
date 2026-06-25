'use strict';

const { ipcMain, shell, dialog, app } = require('electron');
const path = require('path');
const os = require('os');

const JsonStore = require('./store.cjs');
const brew = require('./services/brew.cjs');
const nginx = require('./services/nginx.cjs');
const phpService = require('./services/php.cjs');
const mysql = require('./services/mysql.cjs');
const dnsmasq = require('./services/dnsmasq.cjs');
const wordpress = require('./services/wordpress.cjs');
const sudoers = require('./services/sudoers.cjs');

let store;
let mainWindow;
let serviceStatusCache = {};

function getServiceStatus() {
  const nginxRunning = nginx.isRunning();
  const mysqlRunning = mysql.isRunning();
  const phpVersions = brew.getInstalledPhpVersions();
  const activePhp = brew.getActivePhpVersion();
  const phpRunning = phpService.isPhpFpmRunning(activePhp);
  const dnsmasqRunning = dnsmasq.isRunning();

  serviceStatusCache = {
    nginx: { running: nginxRunning, name: 'nginx' },
    php: { running: phpRunning, name: 'PHP-FPM', version: activePhp },
    mysql: { running: mysqlRunning, name: 'MySQL' },
    dnsmasq: { running: dnsmasqRunning, name: 'dnsmasq' },
  };

  return serviceStatusCache;
}

function registerHandlers(win, storeInstance) {
  mainWindow = win;
  store = storeInstance;

  // Apply persisted DB credentials so MySQL operations authenticate correctly.
  mysql.setCredentials({
    user: store.get('settings.dbUser', 'root'),
    password: store.get('settings.dbPassword', ''),
  });

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

      // Validate domain uniqueness
      const sites = store.get('sites', []);
      if (sites.some((s) => s.domain === siteData.domain)) {
        return { success: false, error: `Domain ${siteData.domain} already exists` };
      }

      // Ensure MySQL is running
      if (!mysql.isRunning()) {
        return { success: false, error: 'MySQL is not running. Start it in the Services panel.' };
      }

      const site = await wordpress.createWordPressSite(siteData, progress);

      const updatedSites = [...sites, site];
      store.set('sites', updatedSites);

      return { success: true, site };
    } catch (err) {
      console.error('add-site error:', err);
      return { success: false, error: err.message };
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
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('open-in-browser', (_, url) => {
    shell.openExternal(url);
    return { success: true };
  });

  ipcMain.handle('open-in-finder', (_, sitePath) => {
    shell.showItemInFolder(sitePath);
    return { success: true };
  });

  ipcMain.handle('open-in-terminal', (_, sitePath) => {
    // Open Terminal.app at the given path
    const { execSync } = require('child_process');
    try {
      execSync(
        `osascript -e 'tell application "Terminal" to do script "cd ${sitePath}" activate'`
      );
    } catch {
      shell.openExternal(`file://${sitePath}`);
    }
    return { success: true };
  });

  // ─── Services ────────────────────────────────────────────────────────

  ipcMain.handle('get-service-status', () => {
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
      return { success: false, error: err.message };
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
      return { success: false, error: err.message };
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
      return { success: false, error: err.message };
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
      return { success: false, error: err.message };
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
      return { success: false, error: err.message };
    }
  });

  // ─── PHP ─────────────────────────────────────────────────────────────

  ipcMain.handle('get-php-versions', () => {
    return phpService.getInstalledPhpVersionsWithDetails();
  });

  ipcMain.handle('switch-php-version', async (_, version) => {
    try {
      phpService.switchActivePhpVersion(version);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ─── Dependencies ────────────────────────────────────────────────────

  ipcMain.handle('check-dependencies', () => {
    return brew.checkAllDependencies();
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
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('uninstall-sudoers', async () => {
    try {
      sudoers.uninstall();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('setup-dnsmasq', async () => {
    try {
      dnsmasq.configureDnsmasq();
      dnsmasq.start();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ─── Settings ────────────────────────────────────────────────────────

  ipcMain.handle('get-settings', () => {
    return {
      sitesDir: store.get('settings.sitesDir', wordpress.DEFAULT_SITES_DIR),
      defaultPhpVersion: store.get('settings.defaultPhpVersion', brew.getActivePhpVersion()),
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
      if (typeof settings.dbUser === 'string') store.set('settings.dbUser', settings.dbUser);
      if (typeof settings.dbPassword === 'string')
        store.set('settings.dbPassword', settings.dbPassword);
      // Re-apply credentials immediately so the running session uses them.
      mysql.setCredentials({
        user: store.get('settings.dbUser', 'root'),
        password: store.get('settings.dbPassword', ''),
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
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

// Periodically push service status updates to renderer
function startStatusPoller(win) {
  setInterval(() => {
    if (win && !win.isDestroyed() && win.webContents) {
      try {
        const status = getServiceStatus();
        win.webContents.send('service-status-update', status);
      } catch {}
    }
  }, 5000);
}

module.exports = { registerHandlers, startStatusPoller, getServiceStatus };
