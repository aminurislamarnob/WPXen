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
    group: 'Personal',
    items: [{ id: 'appearance', label: 'Appearance', icon: 'palette' }],
  },
  {
    group: 'App',
    items: [
      { id: 'general', label: 'General', icon: 'sliders' },
      { id: 'agents', label: 'Agents', icon: 'cpu' },
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
  // ── Appearance ───────────────────────────────────────────────────────────
  {
    id: 'appearance.themeMode',
    section: 'appearance',
    title: 'Appearance',
    description: 'Follow the macOS setting, or force light or dark',
    keywords: [
      'theme',
      'dark',
      'light',
      'dark mode',
      'light mode',
      'appearance',
      'colors',
      'system',
      'night',
    ],
  },
  {
    id: 'appearance.terminal.fontFamily',
    section: 'appearance',
    title: 'Terminal font family',
    description: 'Typeface used by the embedded terminal',
    keywords: [
      'terminal',
      'font',
      'family',
      'typeface',
      'mono',
      'nerd font',
      'typography',
    ],
  },
  {
    id: 'appearance.terminal.fontSize',
    section: 'appearance',
    title: 'Terminal font size',
    description: 'Text size in the embedded terminal',
    keywords: ['terminal', 'font', 'size', 'text', 'bigger', 'smaller', 'typography'],
  },
  {
    id: 'appearance.terminal.lineHeight',
    section: 'appearance',
    title: 'Terminal line height',
    description: 'Vertical spacing between terminal rows',
    keywords: ['terminal', 'line height', 'spacing', 'leading', 'rows', 'typography'],
  },
  {
    id: 'appearance.terminal.letterSpacing',
    section: 'appearance',
    title: 'Terminal letter spacing',
    description: 'Horizontal spacing between characters',
    keywords: [
      'terminal',
      'letter spacing',
      'tracking',
      'kerning',
      'spacing',
      'typography',
    ],
  },
  {
    id: 'appearance.terminal.fontWeight',
    section: 'appearance',
    title: 'Terminal font weight',
    description: 'Stroke weight of terminal text',
    keywords: ['terminal', 'weight', 'bold', 'light', 'font', 'thickness', 'typography'],
  },
  {
    id: 'appearance.terminal.minimumContrast',
    section: 'appearance',
    title: 'Terminal minimum contrast',
    description: 'Force legibility when a program picks a low-contrast colour',
    keywords: [
      'terminal',
      'contrast',
      'legibility',
      'accessibility',
      'colors',
      'readable',
    ],
  },
  {
    id: 'appearance.terminal.cursorStyle',
    section: 'appearance',
    title: 'Terminal cursor style',
    description: 'Block, bar or underline',
    keywords: ['terminal', 'cursor', 'caret', 'block', 'bar', 'underline', 'style'],
  },
  {
    id: 'appearance.terminal.cursorBlink',
    section: 'appearance',
    title: 'Terminal cursor blink',
    description: 'Whether the terminal cursor blinks',
    keywords: ['terminal', 'cursor', 'blink', 'flash', 'caret', 'animation'],
  },
  {
    id: 'appearance.editor.fontFamily',
    section: 'appearance',
    title: 'Editor font family',
    description: 'Typeface used by the code editor and diff views',
    keywords: ['editor', 'font', 'family', 'typeface', 'mono', 'code', 'typography'],
  },
  {
    id: 'appearance.editor.fontSize',
    section: 'appearance',
    title: 'Editor font size',
    description: 'Text size in the code editor',
    keywords: ['editor', 'font', 'size', 'text', 'code', 'bigger', 'typography'],
  },
  {
    id: 'appearance.editor.lineHeight',
    section: 'appearance',
    title: 'Editor line height',
    description: 'Vertical spacing between editor lines',
    keywords: ['editor', 'line height', 'spacing', 'leading', 'code', 'typography'],
  },
  {
    id: 'appearance.editor.letterSpacing',
    section: 'appearance',
    title: 'Editor letter spacing',
    description: 'Horizontal spacing between characters',
    keywords: ['editor', 'letter spacing', 'tracking', 'kerning', 'code', 'typography'],
  },
  {
    id: 'appearance.editor.fontWeight',
    section: 'appearance',
    title: 'Editor font weight',
    description: 'Stroke weight of editor text',
    keywords: ['editor', 'weight', 'bold', 'light', 'font', 'code', 'typography'],
  },
  {
    id: 'appearance.editor.ligatures',
    section: 'appearance',
    title: 'Editor ligatures',
    description: 'Render =>, !== and friends as single glyphs',
    keywords: ['editor', 'ligatures', 'glyphs', 'fira', 'code', 'font', 'typography'],
  },

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
  {
    id: 'app.openLinksIn',
    section: 'general',
    title: 'Open links in',
    description: 'Use the default browser, or a browser tab inside WPHerd',
    keywords: [
      'links',
      'open',
      'browser',
      'external',
      'default',
      'safari',
      'chrome',
      'in-app',
      'preview',
      'wp-admin',
      'phpmyadmin',
    ],
  },
  {
    id: 'browser.clearHistory',
    section: 'general',
    title: 'Clear browsing history',
    description: 'Removes the address-bar suggestions in the Agents browser',
    keywords: [
      'browser',
      'browsing',
      'history',
      'clear',
      'delete',
      'suggestions',
      'autocomplete',
      'address',
      'url',
    ],
  },
  {
    id: 'browser.clearData',
    section: 'general',
    title: 'Clear cookies & cache',
    description: 'Signs you out of every site you signed into in the in-app browser',
    keywords: [
      'browser',
      'cookies',
      'cache',
      'clear',
      'delete',
      'storage',
      'session',
      'sign out',
      'logout',
      'privacy',
    ],
  },

  // ── Agents ───────────────────────────────────────────────────────────────
  {
    id: 'agents.enabled',
    section: 'agents',
    title: 'Available agents',
    description: 'Which agents appear in a site\u2019s launcher',
    keywords: [
      'agents',
      'enabled',
      'claude',
      'codex',
      'gemini',
      'opencode',
      'launcher',
      'ai',
      'show',
      'hide',
    ],
  },
  {
    id: 'agents.commands',
    section: 'agents',
    title: 'Launch commands',
    description: 'Override the command an agent starts with',
    keywords: [
      'agents',
      'command',
      'launch',
      'arguments',
      'flags',
      'cli',
      'override',
      'resume',
    ],
  },
  {
    id: 'agents.custom',
    section: 'agents',
    title: 'Add an agent',
    description: 'Define your own agent CLI',
    keywords: ['agents', 'custom', 'add', 'new', 'own', 'cli', 'define', 'user'],
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
