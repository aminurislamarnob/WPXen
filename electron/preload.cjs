'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Sites
  getSites: () => ipcRenderer.invoke('get-sites'),
  addSite: (data) => ipcRenderer.invoke('add-site', data),
  removeSite: (id, opts) => ipcRenderer.invoke('remove-site', id, opts),
  setSiteHttps: (id, enabled) =>
    ipcRenderer.invoke('set-site-https', id, enabled),
  openSiteInBrowser: (url) => ipcRenderer.invoke('open-in-browser', url),
  openSiteInFinder: (sitePath) => ipcRenderer.invoke('open-in-finder', sitePath),
  openSiteInTerminal: (sitePath) => ipcRenderer.invoke('open-in-terminal', sitePath),
  openWpAdmin: (url) => ipcRenderer.invoke('open-in-browser', `${url}/wp-admin`),
  openPhpMyAdmin: (dbName) => ipcRenderer.invoke('open-phpmyadmin', dbName),

  // Site config (WP Config Manager)
  getWpConfig: (id) => ipcRenderer.invoke('get-wp-config', id),
  setWpConfig: (id, changes) => ipcRenderer.invoke('set-wp-config', id, changes),
  getWpConfigRaw: (id) => ipcRenderer.invoke('get-wp-config-raw', id),
  saveWpConfigRaw: (id, contents) =>
    ipcRenderer.invoke('save-wp-config-raw', id, contents),

  // Share tunnels (Cloudflare)
  checkCloudflared: () => ipcRenderer.invoke('check-cloudflared'),
  installCloudflared: () => ipcRenderer.invoke('install-cloudflared'),
  getTunnels: () => ipcRenderer.invoke('get-tunnels'),
  startTunnel: (id) => ipcRenderer.invoke('start-tunnel', id),
  stopTunnel: (id) => ipcRenderer.invoke('stop-tunnel', id),

  // Services
  getServiceStatus: () => ipcRenderer.invoke('get-service-status'),
  startServices: () => ipcRenderer.invoke('start-services'),
  stopServices: () => ipcRenderer.invoke('stop-services'),
  startService: (name) => ipcRenderer.invoke('start-service', name),
  stopService: (name) => ipcRenderer.invoke('stop-service', name),
  restartService: (name) => ipcRenderer.invoke('restart-service', name),

  // PHP
  getPhpVersions: () => ipcRenderer.invoke('get-php-versions'),
  switchPhpVersion: (version) => ipcRenderer.invoke('switch-php-version', version),
  getInstallablePhpVersions: () =>
    ipcRenderer.invoke('get-installable-php-versions'),
  installPhpVersion: (version) =>
    ipcRenderer.invoke('install-php-version', version),
  updatePhpVersion: (version) =>
    ipcRenderer.invoke('update-php-version', version),
  getPhpIniSettings: () => ipcRenderer.invoke('get-php-ini-settings'),
  setPhpIniSetting: (version, key, value) =>
    ipcRenderer.invoke('set-php-ini-setting', version, key, value),
  setPhpIniSettingAll: (key, value) =>
    ipcRenderer.invoke('set-php-ini-setting-all', key, value),

  // Dependencies & Setup
  checkDependencies: () => ipcRenderer.invoke('check-dependencies'),
  setupDnsmasq: () => ipcRenderer.invoke('setup-dnsmasq'),

  // Sudoers / Permissions
  checkSudoers: () => ipcRenderer.invoke('check-sudoers'),
  installSudoers: () => ipcRenderer.invoke('install-sudoers'),
  uninstallSudoers: () => ipcRenderer.invoke('uninstall-sudoers'),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // File dialogs
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  // System info
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),

  // IPC Events (renderer listening to main)
  on: (channel, callback) => {
    const validChannels = [
      'service-status-update',
      'site-create-progress',
      'php-install-progress',
      'dependencies-update',
      'notification',
      'tunnel-update',
      'cloudflared-install-progress',
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (_, data) => callback(data));
    }
  },
  off: (channel) => {
    const validChannels = [
      'service-status-update',
      'site-create-progress',
      'php-install-progress',
      'dependencies-update',
      'notification',
      'tunnel-update',
      'cloudflared-install-progress',
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.removeAllListeners(channel);
    }
  },
});
