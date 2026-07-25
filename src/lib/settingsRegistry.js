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
    items: [{ id: 'general', label: 'General', icon: 'sliders' }],
  },
  {
    group: 'WordPress',
    items: [
      { id: 'sites', label: 'Sites', icon: 'globe' },
      { id: 'database', label: 'Database', icon: 'database' },
      { id: 'blueprints', label: 'Blueprints', icon: 'layers' },
    ],
  },
  {
    group: 'System',
    items: [
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

  // ── General ──────────────────────────────────────────────────────────────
  {
    id: 'app.startAtLogin',
    section: 'general',
    title: 'Start at Login',
    description: 'Launch WPHerd when you log into macOS',
    keywords: ['start', 'login', 'launch', 'startup', 'boot', 'auto', 'open', 'macos'],
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
