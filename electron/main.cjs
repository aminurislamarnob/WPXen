'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');

const JsonStore = require('./store.cjs');
const { createTray } = require('./tray.cjs');
const { registerHandlers, startStatusPoller, getServiceStatus } = require('./ipc.cjs');

const isDev = process.env.NODE_ENV === 'development';

let mainWindow = null;
let store = null;

// macOS: Don't show in dock (menu bar app), show when window is active
app.dock?.hide();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 940,
    height: 720,
    minWidth: 780,
    minHeight: 580,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    // Fully transparent over the vibrancy material — the renderer paints
    // translucent "Liquid Glass" surfaces on top, so the desktop shows
    // through the whole window like macOS 26 native apps.
    backgroundColor: '#00000000',
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    // Uncomment to open devtools in development:
    // mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    app.dock?.show();
  });

  mainWindow.on('close', (e) => {
    // Hide to tray instead of closing
    e.preventDefault();
    mainWindow.hide();
    app.dock?.hide();
  });

  mainWindow.on('show', () => {
    app.dock?.show();
  });

  return mainWindow;
}

app.whenReady().then(() => {
  // Initialize store
  store = new JsonStore('wpherd-data');

  // Light/dark follows the macOS system appearance: nativeTheme defaults to
  // 'system', which drives the renderer's prefers-color-scheme, and the
  // vibrancy material adapts by itself — nothing to configure.

  // Create main window
  const win = createWindow();

  // Register IPC handlers
  registerHandlers(win, store);

  // Create system tray
  createTray(
    win,
    () => getServiceStatus(),
    () => store.get('sites', [])
  );

  // Start polling service status
  startStatusPoller(win);

  // Services are children of this process now (see procman.cjs), so the app
  // is responsible for bringing them up: migrate away from brew services
  // (one-time), clean up any children orphaned by a previous hard crash,
  // then auto-start. Runs async so the window never waits on it.
  (async () => {
    const procman = require('./services/procman.cjs');
    const migration = require('./services/migration.cjs');
    const brew = require('./services/brew.cjs');
    const nginx = require('./services/nginx.cjs');
    const phpService = require('./services/php.cjs');
    const mysql = require('./services/mysql.cjs');
    const mailpit = require('./services/mailpit.cjs');

    try {
      await migration.migrateToChildProcs(store);
    } catch {}
    try {
      await procman.reconcileOrphans();
    } catch {}

    const starters = [
      () => nginx.start(),
      () => {
        const activePhp = brew.getActivePhpVersion();
        return activePhp ? phpService.startPhpFpm(activePhp) : null;
      },
      () => mysql.start(),
      () => (mailpit.isInstalled() ? mailpit.start() : null),
    ];
    for (const startService of starters) {
      try {
        await startService();
      } catch (err) {
        // A single failing service (e.g. bad nginx config) must not block the
        // others; procman surfaces the failure in the UI.
        console.error('auto-start:', err.message);
      }
    }
  })();

  // macOS: Re-create window if activated with no windows
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Ensure only one instance
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Handle macOS quit properly. Services are child processes now, so quitting
// must tear them down first — but asynchronously: preventDefault on the first
// pass, stop everything under a hard deadline, then exit for real. app.exit()
// (not quit()) so a stuck daemon can never re-enter this handler or hang quit.
let quitCleanupDone = false;
app.on('before-quit', (e) => {
  if (quitCleanupDone) return;
  e.preventDefault();
  quitCleanupDone = true;

  // Allow the window to actually close on quit
  if (mainWindow) {
    mainWindow.removeAllListeners('close');
    mainWindow.close();
  }

  // Kill any live share tunnels so no orphan cloudflared processes linger and
  // no stale nginx server_name aliases are left behind.
  try {
    require('./services/cloudflared.cjs').stopAll();
  } catch {}

  const procman = require('./services/procman.cjs');
  const deadline = new Promise((r) => setTimeout(r, 30_000));
  Promise.race([procman.stopAll({ deadlineMs: 25_000 }), deadline]).finally(() =>
    app.exit(0)
  );
});

// Terminal-initiated shutdowns (dev mode, logout) go through the same cleanup.
process.on('SIGTERM', () => app.quit());
process.on('SIGINT', () => app.quit());
