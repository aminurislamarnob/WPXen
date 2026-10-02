'use strict';

const { Tray, Menu, nativeImage, app } = require('electron');
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

// Agent Sessions that want the user (unread), as menu items that open them.
// Empty when there are none, so the section disappears entirely.
function attentionItems(attention, sites, onOpenSession) {
  if (!attention || attention.length === 0) return [];
  const siteName = (id) => (sites || []).find((s) => s.id === id)?.name || '';
  return [
    { type: 'separator' },
    { label: 'Agents needing attention', enabled: false },
    ...attention.slice(0, 8).map((s) => {
      const glyph = s.state === 'needs-input' ? '🔔' : s.state === 'error' ? '⚠︎' : '✓';
      const where = siteName(s.siteId);
      const title = s.title || s.label || s.agentName;
      return {
        label: `  ${glyph} ${s.agentName}${where ? ` · ${where}` : ''} — ${
          title.length > 40 ? `${title.slice(0, 39)}…` : title
        }`,
        click: () => onOpenSession?.(s),
      };
    }),
  ];
}

const KEEP_AWAKE_LABELS = { on: 'On', agent: 'Agent', off: 'Off' };

// Keep computer awake: the window is usually hidden while agents run, so the
// mode has to be switchable from here. A radio submenu, headed by whether a
// hold is actually in place right now. `setMode` writes through the validated
// settings path, so Settings and the sidebar follow.
function keepAwakeItems(keepAwake) {
  if (!keepAwake) return [];
  const { mode, active } = keepAwake.getStatus();
  const state = active ? 'Active' : 'Inactive';
  return [
    {
      label: 'Keep Computer Awake',
      submenu: [
        { label: `${KEEP_AWAKE_LABELS[mode] || 'Off'} · ${state}`, enabled: false },
        { type: 'separator' },
        ...Object.entries(KEEP_AWAKE_LABELS).map(([value, label]) => ({
          label,
          type: 'radio',
          checked: mode === value,
          click: () => keepAwake.setMode(value),
        })),
      ],
    },
  ];
}

function buildContextMenu(
  mainWindow,
  serviceStatus,
  sites,
  attention,
  onOpenSession,
  keepAwake
) {
  const { nginx, php, mysql } = serviceStatus || {};

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
      label: 'WPXen',
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
      label: 'Open WPXen',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    ...keepAwakeItems(keepAwake),
    ...attentionItems(attention, sites, onOpenSession),
    ...siteItems,
    { type: 'separator' },
    {
      label: 'Quit WPXen',
      accelerator: 'Cmd+Q',
      click: () => {
        app.quit();
      },
    },
  ]);
}

// `getAttention` returns the unread agent Sessions; `onOpenSession(session)`
// opens one. Call `setAttention()` when they change — the 5 s refresh is for
// service status and is too slow for a "needs you" signal. `keepAwake` is
// `{ getStatus, setMode }`; call `updateMenu()` when its status changes.
function createTray(
  mainWindow,
  getStatus,
  getSites,
  { getAttention, onOpenSession, keepAwake } = {}
) {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('WPXen — Local WordPress Development');

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
    const attention = getAttention ? getAttention() : [];
    tray.setContextMenu(
      buildContextMenu(mainWindow, status, sites, attention, onOpenSession, keepAwake)
    );
  }

  // The menu-bar icon is a template image (it can't take a colour), so the
  // unread count rides beside it as the tray title.
  function setAttention() {
    const n = getAttention ? getAttention().length : 0;
    tray.setTitle(n > 0 ? String(n) : '');
    updateMenu();
  }

  updateMenu();

  // Update tray menu periodically
  setInterval(updateMenu, 5000);

  return { tray, updateMenu, setAttention };
}

function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

module.exports = { createTray, destroyTray };
