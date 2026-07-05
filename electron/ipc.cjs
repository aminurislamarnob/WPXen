'use strict';

const { ipcMain, shell, dialog, app } = require('electron');
const { execFile } = require('child_process');
const crypto = require('crypto');
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
const phpmyadmin = require('./services/phpmyadmin.cjs');
const mailpit = require('./services/mailpit.cjs');
const procman = require('./services/procman.cjs');
const cloudflared = require('./services/cloudflared.cjs');
const sudoers = require('./services/sudoers.cjs');
const setup = require('./services/setup.cjs');
const logs = require('./services/logs.cjs');
const validation = require('./services/validation.cjs');
const { humanize } = require('./services/errors.cjs');

let store;
let mainWindow;
let serviceStatusCache = {
  nginx: { running: false, name: 'nginx' },
  php: { running: false, name: 'PHP-FPM', version: null },
  mysql: { running: false, name: 'MySQL' },
  dnsmasq: { running: false, name: 'dnsmasq' },
  mailpit: { running: false, name: 'Mailpit', installed: false },
};

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

  // Supervisor view of each converted service: whether WPHerd owns the
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

  // Apply persisted DB credentials so MySQL operations authenticate correctly.
  mysql.setCredentials({
    user: store.get('settings.dbUser', 'root'),
    password: store.get('settings.dbPassword', ''),
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
      if (store.get('settings.mailCatch', false) && mailpit.isInstalled()) {
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
      const site = sites[idx];

      // Switching scheme rewrites the vhost; drop any live tunnel first so its
      // server_name alias isn't silently lost (the user can re-share after).
      cloudflared.stopTunnel(id);

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
  ipcMain.handle('open-wp-admin', (_, id) => {
    const site = store.get('sites', []).find((s) => s.id === id);
    if (!site) return { success: false, error: 'Site not found' };
    const base = site.url.replace(/\/+$/, '');
    let target = `${base}/wp-admin`;
    if (site.oneClickAdmin?.enabled) {
      const secret = store.get(`magicLogin.${id}`, null);
      if (secret) target = `${base}/?wpherd_magic_login=${secret}`;
    }
    const ok = openExternalSafely(target);
    return ok ? { success: true } : { success: false, error: 'Refused to open unsafe URL' };
  });

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

  ipcMain.handle('open-phpmyadmin', async (_, dbName) => {
    try {
      // Reject anything that isn't a valid DB name before it reaches the URL.
      if (dbName != null && !/^[a-zA-Z0-9_]{1,64}$/.test(dbName)) {
        return { success: false, error: 'Invalid database name.' };
      }
      await phpmyadmin.ensureReady();
      const url = phpmyadmin.getUrl(dbName);
      openExternalSafely(url);
      return { success: true, url };
    } catch (err) {
      return { success: false, error: humanize(err) };
    }
  });

  // ─── Mailpit (email catching) ──────────────────────────────────────────

  ipcMain.handle('get-mailpit-status', async () => {
    const installed = mailpit.isInstalled();
    return {
      installed,
      running: installed ? await mailpit.isRunningAsync() : false,
      catching: !!store.get('settings.mailCatch', false),
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
      mailpit.setCatchEnabled(!!enabled);
      store.set('settings.mailCatch', !!enabled);
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
        if (store.get('settings.mailCatch', false) && mailpit.isInstalled()) {
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
