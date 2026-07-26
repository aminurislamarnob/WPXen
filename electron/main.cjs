'use strict';

const { app, BrowserWindow, dialog, nativeTheme, screen } = require('electron');
const path = require('path');

const JsonStore = require('./store.cjs');
const { isAllowedBrowserUrl } = require('./services/browser.cjs');
const { createTray } = require('./tray.cjs');
const {
  registerHandlers,
  startStatusPoller,
  getServiceStatus,
  getSetting,
} = require('./ipc.cjs');

const isDev = process.env.NODE_ENV === 'development';

let mainWindow = null;
let store = null;

// Opaque window backdrop, matching the renderer's --background token so there's
// no flash of the wrong color while the page paints (or on resize).
const BG_DARK = '#151110'; // ember
const BG_LIGHT = '#ffffff';
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? BG_DARK : BG_LIGHT);

// macOS: Don't show in dock (menu bar app), show when window is active
app.dock?.hide();

// Enabling webviewTag widens what the renderer can mint, so clamp every guest
// as it attaches: no preload, no Node, isolation on. Electron passes `params`
// by reference — mutating it is how the clamp is applied.
//
// The src is usually empty here: a <webview> only starts its guest once the
// element is in the document, so webviewCache attaches first and assigns src
// after. An empty src therefore has to be allowed, and the scheme allowlist
// lives on navigation instead (services/browser.cjs), where it covers every
// navigation rather than just the first.
function hardenWebviews(contents) {
  contents.on('will-attach-webview', (event, params, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;

    if (params.src && !isAllowedBrowserUrl(params.src)) event.preventDefault();
  });
}

function createWindow() {
  // A roomy default window (fits the embedded terminal), centered and clamped
  // to the display so it never opens larger than the screen. Min floor matches
  // Superset's 400×400.
  const { width: waWidth, height: waHeight } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: Math.min(1200, waWidth),
    height: Math.min(800, waHeight),
    minWidth: 400,
    minHeight: 400,
    center: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: windowBackground(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Powers the in-app browser (Agents screen). The guests it can mint are
      // clamped by the will-attach-webview handler below.
      webviewTag: true,
    },
  });

  hardenWebviews(mainWindow.webContents);

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
    // Closing hides to the tray by default — services keep running, which is
    // the point of a menu-bar app. Users who'd rather the close button really
    // quit can say so in Settings → General.
    e.preventDefault();
    if (getSetting('app.closeAction') === 'quit') {
      // Route through app.quit() rather than letting the window close: quitting
      // has to tear down the service children, and before-quit owns that.
      app.quit();
      return;
    }
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

  // Light/dark follows the macOS system appearance by default, but Settings →
  // Appearance can force it: registerHandlers() sets nativeTheme.themeSource
  // from `appearance.themeMode`, which drives the renderer's
  // prefers-color-scheme.
  // The window's opaque backdrop has to be flipped by hand to stay in sync.

  // Create main window
  const win = createWindow();

  nativeTheme.on('updated', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(windowBackground());
    }
  });

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

    // Which services come up on launch is a preference (Settings → Services);
    // Mailpit additionally needs to be installed. Falls back to the historical
    // set if the store hasn't been read yet.
    const autoStart = getSetting('services.autoStart') || [
      'nginx',
      'php',
      'mysql',
      'mailpit',
    ];
    const starters = [
      ['nginx', () => nginx.start()],
      [
        'php',
        () => {
          const activePhp = brew.getActivePhpVersion();
          return activePhp ? phpService.startPhpFpm(activePhp) : null;
        },
      ],
      ['mysql', () => mysql.start()],
      ['mailpit', () => (mailpit.isInstalled() ? mailpit.start() : null)],
    ];
    for (const [name, startService] of starters) {
      if (!autoStart.includes(name)) continue;
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

  // Q11: quitting is the one destructive moment for a Session — an Agent may be
  // mid-edit. Confirm only when a Session is actually live, then tear it down
  // gracefully as part of cleanup below.
  const agents = require('./services/agents.cjs');
  if (agents.hasActiveSessions()) {
    const sitesById = new Map((store?.get('sites', []) || []).map((s) => [s.id, s.name]));
    const names = agents
      .activeSiteIds()
      .map((id) => sitesById.get(id) || id)
      .join(', ');
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Quit Anyway', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'An agent is still running.',
      detail: `Agents are running in: ${names}. Quitting will stop them.`,
    });
    if (choice === 1) {
      e.preventDefault();
      return;
    }
  } else if (getSetting('app.confirmOnQuit') !== false) {
    // Quitting stops every service, which takes all of the user's local sites
    // offline at once. Only worth asking when something is actually running —
    // an "are you sure?" over an idle app is pure noise.
    const status = getServiceStatus();
    const running = Object.values(status)
      .filter((s) => s?.running)
      .map((s) => s.name);
    if (running.length > 0) {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'question',
        buttons: ['Quit', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'Quit WPHerd?',
        detail: `This stops ${running.join(', ')}, taking your local sites offline. You can turn this confirmation off in Settings → General.`,
      });
      if (choice === 1) {
        e.preventDefault();
        return;
      }
    }
  }

  e.preventDefault();
  quitCleanupDone = true;

  try {
    agents.stopAll();
  } catch {}
  try {
    require('./services/browser.cjs').unregisterAll();
  } catch {}

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
