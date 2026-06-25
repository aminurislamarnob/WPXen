'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Sites
  getSites: () => ipcRenderer.invoke('get-sites'),
  addSite: (data) => ipcRenderer.invoke('add-site', data),
  removeSite: (id, opts) => ipcRenderer.invoke('remove-site', id, opts),
  openSiteInBrowser: (url) => ipcRenderer.invoke('open-in-browser', url),
  openSiteInFinder: (sitePath) => ipcRenderer.invoke('open-in-finder', sitePath),
  openSiteInTerminal: (sitePath) => ipcRenderer.invoke('open-in-terminal', sitePath),
  openWpAdmin: (url) => ipcRenderer.invoke('open-in-browser', `${url}/wp-admin`),

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

  // Dependencies & Setup
  checkDependencies: () => ipcRenderer.invoke('check-dependencies'),
  setupDnsmasq: () => ipcRenderer.invoke('setup-dnsmasq'),

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
      'notification',
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (_, data) => callback(data));
    }
  },
  off: (channel) => {
    const validChannels = [
      'service-status-update',
      'site-create-progress',
      'notification',
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.removeAllListeners(channel);
    }
  },
});
