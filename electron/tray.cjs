'use strict';

const { Tray, Menu, nativeImage, app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

let tray = null;

function createTrayIcon() {
  // Use a template image so it adapts to light/dark menu bar
  const iconPath = path.join(__dirname, '../assets/tray.png');
  let icon;
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath);
    icon.setTemplateImage(true);
  } else {
    // Fallback: 1x1 transparent PNG
    icon = nativeImage.createEmpty();
  }
  return icon;
}

function buildContextMenu(mainWindow, serviceStatus, sites) {
  const { nginx, php, mysql, dnsmasq } = serviceStatus || {};

  const statusIcon = (running) => (running ? '●' : '○');

  const siteItems =
    sites && sites.length > 0
      ? [
          { type: 'separator' },
          { label: 'Sites', enabled: false },
          ...sites.slice(0, 8).map((site) => ({
            label: `  ${site.name}`,
            submenu: [
              {
                label: `Open ${site.domain}`,
                click: () => {
                  const { shell } = require('electron');
                  shell.openExternal(site.url);
                },
              },
              {
                label: 'Open in Finder',
                click: () => {
                  const { shell } = require('electron');
                  shell.showItemInFolder(site.path);
                },
              },
              {
                label: 'Open wp-admin',
                click: () => {
                  const { shell } = require('electron');
                  shell.openExternal(`${site.url}/wp-admin`);
                },
              },
            ],
          })),
        ]
      : [{ type: 'separator' }, { label: 'No sites yet', enabled: false }];

  return Menu.buildFromTemplate([
    {
      label: 'WPHerd',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: `${statusIcon(nginx?.running)} nginx`,
      enabled: false,
    },
    {
      label: `${statusIcon(php?.running)} PHP-FPM`,
      enabled: false,
    },
    {
      label: `${statusIcon(mysql?.running)} MySQL`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Open WPHerd',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    ...siteItems,
    { type: 'separator' },
    {
      label: 'Quit WPHerd',
      accelerator: 'Cmd+Q',
      click: () => {
        app.quit();
      },
    },
  ]);
}

function createTray(mainWindow, getStatus, getSites) {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('WPHerd — Local WordPress Development');

  // Show main window on click (macOS: left-click opens menu, so use double-click)
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  function updateMenu() {
    const status = getStatus ? getStatus() : {};
    const sites = getSites ? getSites() : [];
    tray.setContextMenu(buildContextMenu(mainWindow, status, sites));
  }

  updateMenu();

  // Update tray menu periodically
  setInterval(updateMenu, 5000);

  return { tray, updateMenu };
}

function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

module.exports = { createTray, destroyTray };
