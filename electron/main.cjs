'use strict';

const { app, BrowserWindow, nativeTheme } = require('electron');
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
    width: 1100,
    height: 720,
    minWidth: 860,
    minHeight: 580,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#f0f0f1',
    vibrancy: 'under-window',
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

// Handle macOS quit properly
app.on('before-quit', () => {
  // Allow the window to actually close on quit
  if (mainWindow) {
    mainWindow.removeAllListeners('close');
    mainWindow.close();
  }
});
