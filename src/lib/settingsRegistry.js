// Presentation registry for the settings surface.
//
// Every row that appears in Settings is declared here once: its section, its
// copy, and the words a user might search for to find it. This drives the
// sidebar's match counts and the per-row filtering inside each section.
//
// This registry is deliberately NOT the source of truth for persistence — that
// is `electron/services/settings.cjs`, which validates every write. An entry
// here with no matching schema key is fine (rows like "Set up DNS" are actions,
// not stored values); a schema key with no entry here just isn't searchable.

export const SECTIONS = [
  {
    group: 'App',
    items: [
      { id: 'general', label: 'General', icon: 'sliders' },
      { id: 'tools', label: 'External Tools', icon: 'wrench' },
    ],
  },
  {
    group: 'WordPress',
    items: [
      { id: 'sites', label: 'Sites', icon: 'globe' },
      { id: 'database', label: 'Database', icon: 'database' },
      { id: 'mail', label: 'Mail', icon: 'mail' },
      { id: 'blueprints', label: 'Blueprints', icon: 'layers' },
    ],
  },
  {
    group: 'System',
    items: [
      { id: 'services', label: 'Services', icon: 'server' },
      { id: 'dns', label: 'DNS & HTTPS', icon: 'wifi' },
      { id: 'dependencies', label: 'Dependencies', icon: 'package' },
      { id: 'about', label: 'About', icon: 'info' },
    ],
  },
];

export const SETTINGS_ITEMS = [
  // ── Sites ────────────────────────────────────────────────────────────────
  {
    id: 'sites.dir',
    section: 'sites',
    title: 'Default Sites Directory',
    description: 'New WordPress sites will be created here',
    keywords: [
      'sites',
      'directory',
      'folder',
      'path',
      'location',
      'default',
      'where',
      'storage',
    ],
  },
  {
    id: 'php.defaultVersion',
    section: 'sites',
    title: 'Default PHP Version',
    description: 'PHP version new sites are created with',
    keywords: ['php', 'version', 'default', 'new sites', '8.2', '8.3', 'runtime'],
  },

  {
    id: 'sites.defaultWpVersion',
    section: 'sites',
    title: 'Default WordPress Version',
    description: 'WordPress version new installs download',
    keywords: ['wordpress', 'version', 'wp', 'core', 'default', 'latest', 'download'],
  },
  {
    id: 'sites.defaultLocale',
    section: 'sites',
    title: 'Default Locale',
    description: 'Language pack new installs download',
    keywords: ['locale', 'language', 'translation', 'i18n', 'default', 'english'],
  },
  {
    id: 'sites.defaultAdminUser',
    section: 'sites',
    title: 'Default Admin Username',
    description: 'WordPress admin account new sites are created with',
    keywords: ['admin', 'user', 'username', 'wordpress', 'login', 'account', 'default'],
  },
  {
    id: 'sites.defaultAdminEmail',
    section: 'sites',
    title: 'Default Admin Email',
    description: 'Leave blank to derive one from the site domain',
    keywords: ['admin', 'email', 'address', 'wordpress', 'account', 'default', 'mail'],
  },
  {
    id: 'sites.httpsOnCreate',
    section: 'sites',
    title: 'Enable HTTPS on create',
    description: 'Mint a locally-trusted certificate as part of site creation',
    keywords: [
      'https',
      'ssl',
      'tls',
      'certificate',
      'secure',
      'create',
      'default',
      'mkcert',
    ],
  },

  // ── General ──────────────────────────────────────────────────────────────
  {
    id: 'app.startAtLogin',
    section: 'general',
    title: 'Start at Login',
    description: 'Launch WPHerd when you log into macOS',
    keywords: ['start', 'login', 'launch', 'startup', 'boot', 'auto', 'open', 'macos'],
  },
  {
    id: 'app.confirmOnQuit',
    section: 'general',
    title: 'Confirm before quitting',
    description: 'Ask before quitting when services are running',
    keywords: ['quit', 'confirm', 'exit', 'close', 'dialog', 'warning', 'prompt', 'ask'],
  },
  {
    id: 'app.closeAction',
    section: 'general',
    title: 'When the window is closed',
    description: 'Hide to the menu bar, or quit WPHerd entirely',
    keywords: [
      'close',
      'window',
      'tray',
      'menu bar',
      'quit',
      'hide',
      'background',
      'minimize',
    ],
  },

  // ── External tools ───────────────────────────────────────────────────────
  {
    id: 'tools.editor',
    section: 'tools',
    title: 'Open files with',
    description: 'Editor used by “Open in editor” across the app',
    keywords: [
      'editor',
      'vscode',
      'code',
      'cursor',
      'phpstorm',
      'sublime',
      'zed',
      'ide',
      'open',
    ],
  },
  {
    id: 'tools.terminalApp',
    section: 'tools',
    title: 'Open terminals with',
    description: 'Terminal app used by “Open in Terminal”',
    keywords: ['terminal', 'iterm', 'warp', 'ghostty', 'shell', 'console', 'open'],
  },

  // ── Mail ─────────────────────────────────────────────────────────────────
  {
    id: 'mail.catch',
    section: 'mail',
    title: 'Catch outgoing mail',
    description: 'Route PHP mail() into Mailpit instead of sending it for real',
    keywords: [
      'mail',
      'email',
      'catch',
      'mailpit',
      'smtp',
      'sink',
      'inbox',
      'intercept',
      'php',
    ],
  },
  {
    id: 'mail.autoOpenInbox',
    section: 'mail',
    title: 'Open the inbox on new mail',
    description: 'Jump to the Mail page when a caught message arrives',
    keywords: ['mail', 'inbox', 'open', 'notification', 'jump', 'auto', 'message'],
  },

  // ── Services ─────────────────────────────────────────────────────────────
  {
    id: 'services.autoStart',
    section: 'services',
    title: 'Start on Launch',
    description: 'Which services WPHerd brings up when it starts',
    keywords: [
      'services',
      'start',
      'launch',
      'auto',
      'nginx',
      'php',
      'mysql',
      'mailpit',
      'boot',
    ],
  },
  {
    id: 'services.logMaxSizeMb',
    section: 'services',
    title: 'Rotate service logs at',
    description: 'Size past which a service log is moved aside',
    keywords: [
      'logs',
      'rotate',
      'size',
      'disk',
      'cleanup',
      'truncate',
      'services',
      'storage',
    ],
  },

  // ── Database ─────────────────────────────────────────────────────────────
  {
    id: 'db.user',
    section: 'database',
    title: 'MySQL User',
    description: 'Used to create databases and configure WordPress',
    keywords: [
      'mysql',
      'database',
      'user',
      'username',
      'root',
      'credentials',
      'login',
      'db',
    ],
  },
  {
    id: 'db.password',
    section: 'database',
    title: 'MySQL Password',
    description: 'Leave blank for a passwordless root',
    keywords: [
      'mysql',
      'database',
      'password',
      'credentials',
      'secret',
      'root',
      'db',
      'auth',
    ],
  },

  // ── DNS & HTTPS ──────────────────────────────────────────────────────────
  {
    id: 'dns.sudoers',
    section: 'dns',
    title: 'Passwordless DNS Control',
    description: 'Let WPHerd manage the dnsmasq resolver without a password prompt',
    keywords: [
      'sudo',
      'sudoers',
      'password',
      'permission',
      'admin',
      'dnsmasq',
      'privileges',
      'prompt',
    ],
  },
  {
    id: 'dns.resolver',
    section: 'dns',
    title: '*.test DNS Resolution',
    description: 'Route *.test domains to localhost via dnsmasq',
    keywords: [
      'dns',
      'test',
      'domain',
      'resolver',
      'dnsmasq',
      'localhost',
      'hosts',
      'tld',
    ],
  },
  {
    id: 'dns.ca',
    section: 'dns',
    title: 'Local HTTPS Certificate Authority',
    description: 'Trusted certificates for sites switched to HTTPS',
    keywords: [
      'https',
      'ssl',
      'tls',
      'certificate',
      'ca',
      'mkcert',
      'secure',
      'trust',
      'lock',
    ],
  },

  // ── Blueprints ───────────────────────────────────────────────────────────
  {
    id: 'blueprints.list',
    section: 'blueprints',
    title: 'Site Blueprints',
    description: 'Full site snapshots you can create new sites from',
    keywords: [
      'blueprint',
      'snapshot',
      'template',
      'clone',
      'preset',
      'starter',
      'scaffold',
    ],
  },

  // ── Dependencies / About ─────────────────────────────────────────────────
  {
    id: 'dependencies.list',
    section: 'dependencies',
    title: 'Dependencies',
    description: 'Homebrew packages WPHerd needs to run services',
    keywords: [
      'dependencies',
      'homebrew',
      'brew',
      'nginx',
      'mysql',
      'php',
      'dnsmasq',
      'wp-cli',
      'install',
    ],
  },
  {
    id: 'about.system',
    section: 'about',
    title: 'System Information',
    description: 'Platform, Homebrew prefix and version numbers',
    keywords: [
      'about',
      'version',
      'system',
      'platform',
      'electron',
      'node',
      'homebrew',
      'prefix',
      'diagnostics',
    ],
  },
];

const BY_SECTION = SETTINGS_ITEMS.reduce((acc, item) => {
  (acc[item.section] ||= []).push(item);
  return acc;
}, {});

export function itemsForSection(section) {
  return BY_SECTION[section] || [];
}

export function allSectionIds() {
  return SECTIONS.flatMap((g) => g.items.map((i) => i.id));
}
