'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Event channels the renderer may subscribe to. Any channel pushed from the
// main process via event.sender.send(...) must be whitelisted here.
const VALID_EVENT_CHANNELS = [
  'service-status-update',
  'site-create-progress',
  'php-install-progress',
  'dependencies-update',
  'notification',
  'tunnel-update',
  'cloudflared-install-progress',
  'mailpit-install-progress',
  'core-deps-install-progress',
  'site-export-progress',
  'site-import-progress',
  'site-clone-progress',
  'site-changeurl-progress',
  'blueprint-save-progress',
  'terminal-data',
  'terminal-replay',
  'terminal-exit',
  'browser-new-window',
  'browser-shortcut',
  'settings-updated',
];

contextBridge.exposeInMainWorld('electronAPI', {
  // Sites
  getSites: () => ipcRenderer.invoke('get-sites'),
  addSite: (data) => ipcRenderer.invoke('add-site', data),
  removeSite: (id, opts) => ipcRenderer.invoke('remove-site', id, opts),
  setSiteHttps: (id, enabled) => ipcRenderer.invoke('set-site-https', id, enabled),
  openSiteInBrowser: (url) => ipcRenderer.invoke('open-in-browser', url),
  openSiteInFinder: (sitePath) => ipcRenderer.invoke('open-in-finder', sitePath),
  openSiteInTerminal: (sitePath) => ipcRenderer.invoke('open-in-terminal', sitePath),

  // Export / Import
  exportSite: (id) => ipcRenderer.invoke('export-site', id),
  selectImportFile: () => ipcRenderer.invoke('select-import-file'),
  inspectImportArchive: (archivePath) =>
    ipcRenderer.invoke('inspect-import-archive', archivePath),
  importSite: (payload) => ipcRenderer.invoke('import-site', payload),
  cloneSite: (id, target) => ipcRenderer.invoke('clone-site', id, target),
  changeSiteUrl: (id, newDomain) => ipcRenderer.invoke('change-site-url', id, newDomain),
  getCaStatus: () => ipcRenderer.invoke('get-ca-status'),

  // Blueprints
  getBlueprints: () => ipcRenderer.invoke('get-blueprints'),
  saveBlueprint: (id, opts) => ipcRenderer.invoke('save-blueprint', id, opts),
  deleteBlueprint: (id) => ipcRenderer.invoke('delete-blueprint', id),
  createSiteFromBlueprint: (payload) =>
    ipcRenderer.invoke('create-site-from-blueprint', payload),

  // One-click admin (magic login)
  listAdminUsers: (id) => ipcRenderer.invoke('list-admin-users', id),
  setOneClickAdmin: (id, opts) => ipcRenderer.invoke('set-one-click-admin', id, opts),

  // Site config (WP Config Manager)
  getWpConfig: (id) => ipcRenderer.invoke('get-wp-config', id),
  setWpConfig: (id, changes) => ipcRenderer.invoke('set-wp-config', id, changes),
  getWpConfigRaw: (id) => ipcRenderer.invoke('get-wp-config-raw', id),
  saveWpConfigRaw: (id, contents) =>
    ipcRenderer.invoke('save-wp-config-raw', id, contents),

  // Site PHP settings
  getSitePhp: (id) => ipcRenderer.invoke('get-site-php', id),
  setSitePhp: (id, payload) => ipcRenderer.invoke('set-site-php', id, payload),

  // WordPress overview / updates
  getWpOverview: (id) => ipcRenderer.invoke('get-wp-overview', id),
  updateWpCore: (id) => ipcRenderer.invoke('update-wp-core', id),
  updateWpItem: (id, type, name) => ipcRenderer.invoke('update-wp-item', id, type, name),
  updateWpAll: (id) => ipcRenderer.invoke('update-wp-all', id),

  // Plugin management
  getWpPlugins: (id) => ipcRenderer.invoke('get-wp-plugins', id),
  wpPluginAction: (id, action, names) =>
    ipcRenderer.invoke('wp-plugin-action', id, action, names),
  wpPluginAutoUpdate: (id, name, enabled) =>
    ipcRenderer.invoke('wp-plugin-auto-update', id, name, enabled),
  wpPluginInstall: (id, slug, activate) =>
    ipcRenderer.invoke('wp-plugin-install', id, slug, activate),

  // Theme management
  getWpThemes: (id) => ipcRenderer.invoke('get-wp-themes', id),
  wpThemeAction: (id, action, names) =>
    ipcRenderer.invoke('wp-theme-action', id, action, names),
  wpThemeAutoUpdate: (id, name, enabled) =>
    ipcRenderer.invoke('wp-theme-auto-update', id, name, enabled),
  wpThemeInstall: (id, slug, activate) =>
    ipcRenderer.invoke('wp-theme-install', id, slug, activate),

  // Site logs
  getSiteLog: (id, kind) => ipcRenderer.invoke('get-site-log', id, kind),
  clearSiteLog: (id, kind) => ipcRenderer.invoke('clear-site-log', id, kind),
  saveSiteLog: (id, kind) => ipcRenderer.invoke('save-site-log', id, kind),

  // Mailpit (email catching)
  getMailpitStatus: () => ipcRenderer.invoke('get-mailpit-status'),
  installMailpit: () => ipcRenderer.invoke('install-mailpit'),
  setMailCatching: (enabled) => ipcRenderer.invoke('set-mail-catching', enabled),
  openMailpit: (messageId) => ipcRenderer.invoke('open-mailpit', messageId),
  getMailMessages: (opts) => ipcRenderer.invoke('get-mail-messages', opts),
  getMailMessage: (id) => ipcRenderer.invoke('get-mail-message', id),
  deleteMailMessages: (ids) => ipcRenderer.invoke('delete-mail-messages', ids),
  markMailRead: () => ipcRenderer.invoke('mark-mail-read'),

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
  openServiceLog: (name) => ipcRenderer.invoke('open-service-log', name),

  // PHP
  getPhpVersions: () => ipcRenderer.invoke('get-php-versions'),
  switchPhpVersion: (version) => ipcRenderer.invoke('switch-php-version', version),
  getInstallablePhpVersions: () => ipcRenderer.invoke('get-installable-php-versions'),
  installPhpVersion: (version) => ipcRenderer.invoke('install-php-version', version),
  updatePhpVersion: (version) => ipcRenderer.invoke('update-php-version', version),
  getPhpIniSettings: () => ipcRenderer.invoke('get-php-ini-settings'),
  setPhpIniSetting: (version, key, value) =>
    ipcRenderer.invoke('set-php-ini-setting', version, key, value),
  setPhpIniSettingAll: (key, value) =>
    ipcRenderer.invoke('set-php-ini-setting-all', key, value),

  // Dependencies & Setup
  checkDependencies: () => ipcRenderer.invoke('check-dependencies'),
  setupDnsmasq: () => ipcRenderer.invoke('setup-dnsmasq'),

  // First-run onboarding
  installCoreDeps: () => ipcRenderer.invoke('install-core-deps'),
  openHomebrewInstaller: () => ipcRenderer.invoke('open-homebrew-installer'),
  getOnboardingState: () => ipcRenderer.invoke('get-onboarding-state'),
  setOnboardingComplete: () => ipcRenderer.invoke('set-onboarding-complete'),

  // Sudoers / Permissions
  checkSudoers: () => ipcRenderer.invoke('check-sudoers'),
  installSudoers: () => ipcRenderer.invoke('install-sudoers'),
  uninstallSudoers: () => ipcRenderer.invoke('uninstall-sudoers'),

  // Settings
  // Schema-backed settings. `setSettings` takes a patch of dotted keys and
  // resolves with { ok, applied, rejected } — it never throws on a bad value.
  getAllSettings: () => ipcRenderer.invoke('settings-get-all'),
  setSettings: (patch) => ipcRenderer.invoke('settings-set', patch),
  // Editors/terminals detected on this machine, for the settings pickers.
  listExternalTools: () => ipcRenderer.invoke('list-external-tools'),
  // Every agent including ones hidden from the launcher (settings only).
  listAllAgents: () => ipcRenderer.invoke('agent-list-all'),
  // Deprecated flat shape, kept for one release. Prefer the two above.
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // File dialogs
  selectFolder: (defaultPath) => ipcRenderer.invoke('select-folder', defaultPath),

  // System info
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),

  // Agent Launcher / Terminal
  listAgents: () => ipcRenderer.invoke('agent-list'),
  listSessions: (siteId) => ipcRenderer.invoke('agent-sessions', siteId),
  launchAgent: (siteId, agentId, targetId) =>
    ipcRenderer.invoke('agent-launch', siteId, agentId, targetId),

  // Launch Presets (global, per-Agent) & Launch Targets (per-Site)
  getAgentPresets: () => ipcRenderer.invoke('agent-presets-get'),
  setAgentPreset: (agentId, args) =>
    ipcRenderer.invoke('agent-preset-set', agentId, args),
  listLaunchTargets: (siteId) => ipcRenderer.invoke('agent-targets-list', siteId),
  saveLaunchTarget: (siteId, target) =>
    ipcRenderer.invoke('agent-target-save', siteId, target),
  deleteLaunchTarget: (siteId, targetId) =>
    ipcRenderer.invoke('agent-target-delete', siteId, targetId),
  terminalReady: (sessionId) => ipcRenderer.invoke('terminal-ready', sessionId),
  terminalInput: (sessionId, data) => ipcRenderer.send('terminal-input', sessionId, data),
  terminalResize: (sessionId, cols, rows) =>
    ipcRenderer.send('terminal-resize', sessionId, cols, rows),
  terminalClear: (sessionId) => ipcRenderer.send('terminal-clear', sessionId),
  terminalStop: (sessionId) => ipcRenderer.invoke('terminal-stop', sessionId),

  // In-app browser. The renderer owns the <webview>; these reach its guest in
  // the main process, keyed by the browser tab's key.
  browserRegister: (tabKey, webContentsId) =>
    ipcRenderer.invoke('browser-register', tabKey, webContentsId),
  browserUnregister: (tabKey) => ipcRenderer.invoke('browser-unregister', tabKey),
  browserNavigate: (tabKey, url) => ipcRenderer.invoke('browser-navigate', tabKey, url),
  browserReload: (tabKey, hard) => ipcRenderer.invoke('browser-reload', tabKey, hard),
  browserOpenDevTools: (tabKey) => ipcRenderer.invoke('browser-open-devtools', tabKey),
  // Targets an in-app browser tab can be pointed at. These resolve a URL
  // (installing/configuring the service on first use) instead of opening it.
  getPhpMyAdminUrl: (dbName) => ipcRenderer.invoke('get-phpmyadmin-url', dbName),
  getWpAdminUrl: (id) => ipcRenderer.invoke('get-wp-admin-url', id),
  getMailpitUrl: () => ipcRenderer.invoke('get-mailpit-url'),
  // Address-bar autocomplete + the Settings actions that wipe it.
  browserHistoryRecord: (visit) => ipcRenderer.invoke('browser-history-record', visit),
  browserHistorySearch: (query, limit) =>
    ipcRenderer.invoke('browser-history-search', query, limit),
  browserHistoryClear: () => ipcRenderer.invoke('browser-history-clear'),
  browserClearData: () => ipcRenderer.invoke('browser-clear-data'),

  listDirectory: (rootPath, dirPath) =>
    ipcRenderer.invoke('list-directory', rootPath, dirPath),
  terminalStatPath: (rootPath, candidate) =>
    ipcRenderer.invoke('terminal-stat-path', rootPath, candidate),
  openFilePath: (filePath) => ipcRenderer.invoke('open-file-path', filePath),
  readFile: (rootPath, filePath) => ipcRenderer.invoke('read-file', rootPath, filePath),
  writeFile: (rootPath, filePath, content) =>
    ipcRenderer.invoke('write-file', rootPath, filePath, content),
  revealInFinder: (rootPath, targetPath) =>
    ipcRenderer.invoke('reveal-in-finder', rootPath, targetPath),
  createFile: (rootPath, dirPath, name) =>
    ipcRenderer.invoke('create-file', rootPath, dirPath, name),
  createFolder: (rootPath, dirPath, name) =>
    ipcRenderer.invoke('create-folder', rootPath, dirPath, name),
  renamePath: (rootPath, targetPath, newName) =>
    ipcRenderer.invoke('rename-path', rootPath, targetPath, newName),
  importFiles: (rootPath, dirPath, sourcePaths) =>
    ipcRenderer.invoke('import-files', rootPath, dirPath, sourcePaths),
  trashPath: (rootPath, targetPath) =>
    ipcRenderer.invoke('trash-path', rootPath, targetPath),
  gitStatus: (rootPath) => ipcRenderer.invoke('git-status', rootPath),
  gitFileAt: (siteRoot, repoRoot, rel, rev) =>
    ipcRenderer.invoke('git-file-at', siteRoot, repoRoot, rel, rev),
  gitStage: (siteRoot, repoRoot, rels) =>
    ipcRenderer.invoke('git-stage', siteRoot, repoRoot, rels),
  gitUnstage: (siteRoot, repoRoot, rels) =>
    ipcRenderer.invoke('git-unstage', siteRoot, repoRoot, rels),
  gitDiscard: (siteRoot, repoRoot, rel, status) =>
    ipcRenderer.invoke('git-discard', siteRoot, repoRoot, rel, status),

  // IPC Events (renderer listening to main). `on` returns an unsubscribe that
  // removes only its own listener — required when several subscribers share a
  // channel (e.g. many live terminals on 'terminal-data'). `off` (remove all)
  // stays for single-subscriber callers that use it in cleanup.
  on: (channel, callback) => {
    if (!VALID_EVENT_CHANNELS.includes(channel)) return () => {};
    const wrapped = (_, data) => callback(data);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  off: (channel) => {
    if (VALID_EVENT_CHANNELS.includes(channel)) {
      ipcRenderer.removeAllListeners(channel);
    }
  },
});
