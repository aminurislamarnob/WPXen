'use strict';

const { execSync, execFileSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const brew = require('./brew.cjs');
const mysql = require('./mysql.cjs');
const nginx = require('./nginx.cjs');
const { validateSiteInput } = require('./validation.cjs');

const DEFAULT_SITES_DIR = path.join(os.homedir(), 'Sites');

// NB: there is deliberately no getSitesDir() helper here. The sites directory
// is a user setting ('sites.dir'); a module-local helper returning the constant
// would silently ignore it. Callers receive the resolved path in siteData.

function getWpCliBin() {
  const prefix = brew.getBrewPrefix();
  const candidates = [
    prefix ? `${prefix}/bin/wp` : null,
    '/usr/local/bin/wp',
    path.join(os.homedir(), '.composer/vendor/bin/wp'),
  ].filter(Boolean);

  const fsCandidates = candidates.filter((c) => fs.existsSync(c));
  if (fsCandidates.length > 0) return fsCandidates[0];

  try {
    return execSync('which wp').toString().trim();
  } catch {
    return null;
  }
}

// Runs WP-CLI. `args` is an ARRAY of arguments — passed via execFileSync with
// no shell, so values like the site title or admin password can't be
// interpreted as shell metacharacters (command injection). Never build this
// from a concatenated string.
function wp(args, cwd, extraEnv = {}) {
  if (!Array.isArray(args)) {
    throw new TypeError('wp() requires an array of arguments');
  }
  const wpBin = getWpCliBin();
  if (!wpBin) throw new Error('WP-CLI not found. Install with: brew install wp-cli');
  const prefix = brew.getBrewPrefix();
  const phpBin = prefix ? `${prefix}/bin/php` : 'php';

  const env = {
    ...process.env,
    PATH: `${prefix}/bin:${process.env.PATH}`,
    HOME: os.homedir(),
    ...extraEnv,
  };

  // Newer PHP (8.4/8.5) makes WP-CLI's bundled deps emit deprecation notices.
  // Route all PHP diagnostics to stderr and silence deprecations so they never
  // contaminate the captured stdout (e.g. `wp core version`).
  const phpArgs = [
    '-d',
    'error_reporting=E_ALL & ~E_DEPRECATED & ~E_STRICT',
    '-d',
    'display_errors=stderr',
  ];

  return execFileSync(phpBin, [...phpArgs, wpBin, ...args, '--allow-root'], {
    cwd,
    env,
    stdio: 'pipe',
    timeout: 120000,
  })
    .toString()
    .trim();
}

// Async variant of wp() for long-running or UI-facing calls (core/plugin/theme
// updates, inventory listing). Same no-shell argv contract and PHP diagnostics
// routing, but runs off the main thread so the app stays responsive.
function wpAsync(args, cwd, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(args)) {
      reject(new TypeError('wpAsync() requires an array of arguments'));
      return;
    }
    const wpBin = getWpCliBin();
    if (!wpBin) {
      reject(new Error('WP-CLI not found. Install with: brew install wp-cli'));
      return;
    }
    const prefix = brew.getBrewPrefix();
    const phpBin = prefix ? `${prefix}/bin/php` : 'php';
    const env = {
      ...process.env,
      PATH: `${prefix}/bin:${process.env.PATH}`,
      HOME: os.homedir(),
    };
    const phpArgs = [
      '-d',
      'error_reporting=E_ALL & ~E_DEPRECATED & ~E_STRICT',
      '-d',
      'display_errors=stderr',
    ];
    execFile(
      phpBin,
      [...phpArgs, wpBin, ...args, '--allow-root'],
      { cwd, env, timeout, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          reject(err);
        } else {
          resolve(stdout.toString().trim());
        }
      }
    );
  });
}

// WP-CLI output should be a bare version like "6.8.2". Guard against any stray
// warning text sneaking in by keeping only a version-shaped token.
function sanitizeWpVersion(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^\d+\.\d+(?:\.\d+)*$/) ? raw.trim() : null;
  return m;
}

async function createWordPressSite(siteData, progressCallback) {
  const {
    name,
    domain,
    path: sitePath,
    phpVersion,
    dbName,
    adminUser = 'admin',
    adminPassword = 'admin123',
    adminEmail,
    title,
    wpVersion: wpVersionArg,
    locale: localeArg,
  } = siteData;

  const progress = progressCallback || (() => {});

  // Validate before touching the filesystem, DB, or shelling out. This is the
  // authoritative check (the renderer's form validation is advisory only).
  const { valid, errors } = validateSiteInput(siteData);
  if (!valid) {
    throw new Error(errors.join(' '));
  }

  // 1. Create site directory
  progress({ step: 'directory', message: 'Creating site directory...' });
  fs.mkdirSync(sitePath, { recursive: true });

  // 2. Download WordPress core (with bundled default themes/plugins — no
  // --skip-content, so the Twenty* themes ship with the install).
  //
  // Version and locale come from the global new-site defaults. Both are
  // pattern-checked before becoming argv so a tampered store can't smuggle an
  // extra wp-cli flag through them; anything unrecognised falls back to the
  // latest en_US build rather than failing the install.
  progress({ step: 'download', message: 'Downloading WordPress...' });
  const downloadArgs = ['core', 'download'];
  if (
    wpVersionArg &&
    wpVersionArg !== 'latest' &&
    /^\d+(\.\d+){0,2}$/.test(wpVersionArg)
  ) {
    downloadArgs.push(`--version=${wpVersionArg}`);
  }
  if (
    localeArg &&
    /^[a-z]{2,3}(_[A-Za-z]{2,4})?$/.test(localeArg) &&
    localeArg !== 'en_US'
  ) {
    downloadArgs.push(`--locale=${localeArg}`);
  }
  wp(downloadArgs, sitePath);

  // 3. Create database
  progress({ step: 'database', message: 'Creating database...' });
  mysql.createDatabase(dbName);

  // 4. Create wp-config.php
  progress({ step: 'config', message: 'Configuring WordPress...' });
  const { user: dbUser, password: dbPass } = mysql.getCredentials();
  // Use 'localhost' so PHP connects over the same socket the CLI used,
  // matching the credentials' host grant (e.g. 'root'@'localhost').
  // Each array element is a single argv token — no shell, no injection.
  wp(
    [
      'config',
      'create',
      `--dbname=${dbName}`,
      `--dbuser=${dbUser}`,
      `--dbpass=${dbPass}`,
      '--dbhost=localhost',
      '--force',
    ],
    sitePath
  );

  // 5. Install WordPress
  progress({ step: 'install', message: 'Installing WordPress...' });
  wp(
    [
      'core',
      'install',
      `--url=http://${domain}`,
      `--title=${title || name}`,
      `--admin_user=${adminUser}`,
      `--admin_password=${adminPassword}`,
      `--admin_email=${adminEmail || `admin@${domain}`}`,
      '--skip-email',
    ],
    sitePath
  );

  // 6. Ensure the newest bundled default theme is active. WP activates it
  // automatically on a fresh install, but do it explicitly so the site always
  // lands on the latest Twenty* theme even if that ever changes.
  progress({ step: 'theme', message: 'Activating default theme...' });
  activateLatestDefaultTheme(sitePath);

  // 7. Create nginx config
  progress({ step: 'nginx', message: 'Configuring nginx...' });
  nginx.createSiteConfig({ name, domain, path: sitePath, phpVersion });

  // 8. Reload nginx
  progress({ step: 'reload', message: 'Reloading nginx...' });
  try {
    nginx.reload();
  } catch {
    // nginx might not be running yet
  }

  progress({ step: 'done', message: 'WordPress site ready!' });

  // Get WordPress version
  let wpVersion = 'unknown';
  try {
    wpVersion = sanitizeWpVersion(wp(['core', 'version'], sitePath)) || 'unknown';
  } catch {}

  return {
    id: generateId(),
    name,
    domain,
    path: sitePath,
    phpVersion,
    dbName,
    adminUser,
    adminEmail: adminEmail || `admin@${domain}`,
    wpVersion,
    url: `http://${domain}`,
    createdAt: new Date().toISOString(),
  };
}

// Activates the latest bundled core default theme (the newest Twenty* theme).
// Uses WP_Theme::get_core_default_theme() — the same lookup WordPress itself
// uses to pick the fallback theme — so it always resolves to the newest one
// shipped with this WP version. Best-effort: never fails the site creation.
function activateLatestDefaultTheme(sitePath) {
  try {
    const latest = wp(
      [
        'eval',
        'if ($t = WP_Theme::get_core_default_theme()) { echo $t->get_stylesheet(); }',
      ],
      sitePath
    ).trim();
    if (latest) {
      wp(['theme', 'activate', latest], sitePath);
    }
  } catch {
    // A fresh install already activates the newest default theme, so this is
    // only a best-effort guarantee.
  }
}

function removeWordPressSite(site, opts = {}) {
  // Remove nginx config
  nginx.removeSiteConfig(site.domain);

  // Drop database
  if (opts.removeDatabase !== false) {
    try {
      mysql.dropDatabase(site.dbName);
    } catch {}
  }

  // Remove files
  if (opts.removeFiles && fs.existsSync(site.path)) {
    fs.rmSync(site.path, { recursive: true, force: true });
  }

  // Reload nginx
  try {
    nginx.reload();
  } catch {}
}

// Updates a site's WordPress home/siteurl options so WP generates links with
// the given scheme (http/https). Best-effort — a fresh or broken install may
// not respond, in which case nginx still serves the chosen scheme.
function setSiteUrl(sitePath, url) {
  wp(['option', 'update', 'home', url], sitePath);
  wp(['option', 'update', 'siteurl', url], sitePath);
}

// From a .wpress package.json Plugins list, keep only the plugin basenames
// whose file actually exists on disk — mirrors AI1WM's ai1wm_activate_plugins,
// which skips entries that fail validate_plugin(). `exists` is injected so this
// stays pure and unit-testable. Returns a de-duplicated array.
function selectExistingPlugins(plugins, exists) {
  if (!Array.isArray(plugins)) return [];
  const seen = new Set();
  const out = [];
  for (const p of plugins) {
    if (typeof p === 'string' && p && !seen.has(p) && exists(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

// All-in-One WP Migration blanks active_plugins/template/stylesheet in its DB
// export (so nothing fatals mid-restore) and re-applies them from package.json
// in its own importer. WPDevPilot imports the DB directly, so without this step
// every plugin and the site theme come back deactivated. Replicates AI1WM's
// final activation — direct option writes, filtered to entries whose files are
// present (matching ai1wm_activate_plugins/template/stylesheet).
function restoreWpressActiveState(sitePath, pkg) {
  if (!pkg || typeof pkg !== 'object') return;

  // Theme: only point template/stylesheet at a theme that's actually present.
  const themesDir = path.join(sitePath, 'wp-content', 'themes');
  for (const [option, value] of [
    ['template', pkg.Template],
    ['stylesheet', pkg.Stylesheet],
  ]) {
    if (value && fs.existsSync(path.join(themesDir, value))) {
      try {
        wp(['option', 'update', option, value], sitePath);
      } catch {}
    }
  }

  // Plugins: rebuild active_plugins from the basenames whose files exist.
  const pluginsDir = path.join(sitePath, 'wp-content', 'plugins');
  const active = selectExistingPlugins(pkg.Plugins, (p) =>
    fs.existsSync(path.join(pluginsDir, p))
  );
  try {
    wp(
      ['option', 'update', 'active_plugins', JSON.stringify(active), '--format=json'],
      sitePath
    );
  } catch {}
}

// Deletes a mu-plugin left behind under its pre-rename (WPHerd) file name.
// Both copies would otherwise load and redeclare the same functions — a fatal
// error for the tunnel plugin, and a live second magic-login route holding a
// stale secret. Best-effort: a read-only wp-content just keeps the old file.
function removeLegacyMuPlugin(sitePath, name) {
  const file = path.join(sitePath, 'wp-content', 'mu-plugins', name);
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {}
}

// Drops a must-use plugin that makes WordPress emit URLs for whatever host the
// request actually arrived on when that host is a *.trycloudflare.com share
// domain. Without it, WP would generate `http://<site>.test` links that break
// for anyone visiting through the public tunnel. Idempotent, and inert for
// normal local (.test) access. Best-effort — a missing wp-content is ignored.
function ensureTunnelMuPlugin(sitePath) {
  const muDir = path.join(sitePath, 'wp-content', 'mu-plugins');
  const file = path.join(muDir, 'wpdevpilot-tunnel.php');
  const contents = `<?php
/**
 * Plugin Name: WPDevPilot Share Tunnel
 * Description: Serves correct URLs when the site is accessed through a WPDevPilot Cloudflare share tunnel. Managed by WPDevPilot.
 */
if (!defined('ABSPATH')) {
    exit;
}

/**
 * True when the current request arrived on a Cloudflare quick-tunnel share host.
 */
function wpdevpilot_is_tunnel_request() {
    return !empty($_SERVER['HTTP_HOST'])
        && substr($_SERVER['HTTP_HOST'], -18) === '.trycloudflare.com';
}

// Cloudflare terminates TLS at the edge and forwards to the local origin over
// plain HTTP, so WordPress sees is_ssl() === false while home/siteurl are https
// (below). That scheme mismatch makes wp-admin / wp-login redirect http->https
// endlessly (ERR_TOO_MANY_REDIRECTS). Mark tunnel requests as HTTPS — matching
// the edge — so is_ssl() agrees with the https site URL and the loop is gone.
// This runs at mu-plugin load, before any admin auth/SSL redirect check.
if (wpdevpilot_is_tunnel_request()) {
    $_SERVER['HTTPS'] = 'on';
}

/**
 * When the request host is a Cloudflare quick-tunnel domain, override the
 * home/siteurl so all generated links point at the public tunnel URL.
 */
function wpdevpilot_tunnel_filter_url($value) {
    if (wpdevpilot_is_tunnel_request()) {
        // Cloudflare quick tunnels are always served over https at the edge.
        return 'https://' . $_SERVER['HTTP_HOST'];
    }
    return $value;
}
add_filter('option_home', 'wpdevpilot_tunnel_filter_url');
add_filter('option_siteurl', 'wpdevpilot_tunnel_filter_url');
`;

  try {
    if (!fs.existsSync(path.join(sitePath, 'wp-content'))) return false;
    if (!fs.existsSync(muDir)) fs.mkdirSync(muDir, { recursive: true });
    fs.writeFileSync(file, contents, 'utf8');
    removeLegacyMuPlugin(sitePath, 'wpherd-tunnel.php');
    return true;
  } catch {
    return false;
  }
}

// ─── One-Click Admin (magic login) ─────────────────────────────────────────
//
// Passwordless login to wp-admin as a chosen administrator, LocalWP-style. A
// managed mu-plugin watches for a magic token on the request; when it matches
// the per-site secret it sets the auth cookie for the selected user and
// redirects into the dashboard. Local access only — it refuses to authenticate
// over a public share tunnel (mirrors LocalWP's "won't work with Live Links").

// Lists the site's administrator accounts for the account picker.
function listAdminUsers(sitePath) {
  const out = wp(
    [
      'user',
      'list',
      '--role=administrator',
      '--fields=ID,user_login,display_name',
      '--format=json',
    ],
    sitePath
  );
  let parsed;
  try {
    parsed = JSON.parse(out || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((u) => ({
    id: Number(u.ID),
    login: u.user_login,
    name: u.display_name || u.user_login,
  }));
}

// Writes the managed magic-login mu-plugin, baking in the chosen user id and the
// per-site secret. Idempotent — call again to switch users or rotate the secret.
function ensureMagicLoginMuPlugin(sitePath, { userId, secret }) {
  const muDir = path.join(sitePath, 'wp-content', 'mu-plugins');
  const file = path.join(muDir, 'wpdevpilot-magic-login.php');
  const uid = parseInt(userId, 10);
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new Error('A valid administrator must be selected.');
  }
  if (!/^[a-f0-9]{16,}$/i.test(String(secret || ''))) {
    throw new Error('Invalid magic-login secret.');
  }
  const contents = `<?php
/**
 * Plugin Name: WPDevPilot One-Click Admin
 * Description: Passwordless admin login for local development. Managed by WPDevPilot — local access only.
 */
if (!defined('ABSPATH')) {
    exit;
}

add_action('init', function () {
    if (empty($_GET['wpdevpilot_magic_login']) || !is_string($_GET['wpdevpilot_magic_login'])) {
        return;
    }
    $secret  = '${secret}';
    $user_id = ${uid};
    // Local development only: never authenticate over a public share tunnel.
    $host = isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : '';
    if (substr($host, -18) === '.trycloudflare.com') {
        return;
    }
    if (!hash_equals($secret, $_GET['wpdevpilot_magic_login'])) {
        return;
    }
    $user = get_user_by('id', $user_id);
    if (!$user) {
        return;
    }
    wp_set_current_user($user->ID, $user->user_login);
    wp_set_auth_cookie($user->ID, true);
    do_action('wp_login', $user->user_login, $user);
    wp_safe_redirect(admin_url());
    exit;
}, 0);
`;

  if (!fs.existsSync(path.join(sitePath, 'wp-content'))) {
    throw new Error('wp-content not found for this site.');
  }
  if (!fs.existsSync(muDir)) fs.mkdirSync(muDir, { recursive: true });
  fs.writeFileSync(file, contents, 'utf8');
  removeLegacyMuPlugin(sitePath, 'wpherd-magic-login.php');
  return true;
}

// Removes the managed magic-login mu-plugin (when the feature is turned off).
function removeMagicLoginMuPlugin(sitePath) {
  const file = path.join(
    sitePath,
    'wp-content',
    'mu-plugins',
    'wpdevpilot-magic-login.php'
  );
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    removeLegacyMuPlugin(sitePath, 'wpherd-magic-login.php');
    return true;
  } catch {
    return false;
  }
}

function getSiteWordPressVersion(sitePath) {
  try {
    return sanitizeWpVersion(wp(['core', 'version'], sitePath));
  } catch {
    return null;
  }
}

// ─── WP Config Manager ─────────────────────────────────────────────────────
//
// Managed wp-config.php constants, edited through WP-CLI's `config` command
// (which uses the WPConfigTransformer under the hood — no DB required, and it
// preserves the rest of the file). Each is exposed as a toggle or a select in
// the site's WP Config panel.
const WP_CONFIG_SETTINGS = [
  {
    key: 'WP_DEBUG',
    label: 'Enable Debug Mode',
    type: 'bool',
    default: false,
    description:
      "WP_DEBUG is the master switch for WordPress debugging. It must be on for the debug log and debug display below to have any effect. Keep it off unless you're actively debugging.",
  },
  {
    key: 'WP_DEBUG_LOG',
    label: 'Enable Debug Log',
    type: 'bool',
    default: false,
    dependsOn: 'WP_DEBUG',
    description:
      'Write errors and notices to wp-content/debug.log. Requires Debug Mode to be enabled.',
  },
  {
    key: 'WP_DEBUG_DISPLAY',
    label: 'Enable Debug Display',
    type: 'bool',
    // WordPress defaults this to true (errors shown) once WP_DEBUG is on.
    default: true,
    dependsOn: 'WP_DEBUG',
    description:
      'Show PHP errors and notices in the page output. Requires Debug Mode. Turn this off to log errors without printing them on the site.',
  },
  {
    key: 'SCRIPT_DEBUG',
    label: 'Enable Script Debug',
    type: 'bool',
    default: false,
    description:
      "Load the unminified 'dev' versions of core CSS and JavaScript. Useful when debugging front-end or admin scripts.",
  },
  {
    key: 'CONCATENATE_SCRIPTS',
    label: 'Enable Script Concatenation',
    type: 'bool',
    default: false,
    description:
      'Concatenate admin JavaScript into fewer requests. Disable this if you are debugging JavaScript in the admin area.',
  },
  {
    key: 'SAVEQUERIES',
    label: 'Enable Save Queries',
    type: 'bool',
    default: false,
    description:
      'Store every database query (with call stack and timing) in $wpdb->queries for analysis. Has a performance cost — leave off unless debugging.',
  },
];

function isTruthyConfigValue(raw) {
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === 'true' || v === '1';
}

// Reads the managed constants from a site's wp-config.php via WP-CLI. Returns a
// values map keyed by constant, with sensible defaults for anything unset.
function getWpConfig(sitePath) {
  const values = {};
  for (const s of WP_CONFIG_SETTINGS) {
    values[s.key] = s.type === 'bool' ? (s.default ?? false) : s.default;
  }

  let list = [];
  try {
    const out = wp(
      ['config', 'list', '--fields=name,value,type', '--format=json'],
      sitePath
    );
    list = JSON.parse(out);
  } catch {
    return values;
  }

  const byName = new Map();
  for (const item of list) {
    if (item && item.name) byName.set(item.name, item.value);
  }

  for (const s of WP_CONFIG_SETTINGS) {
    if (!byName.has(s.key)) continue;
    if (s.type === 'bool') {
      values[s.key] = isTruthyConfigValue(byName.get(s.key));
    }
  }
  return values;
}

// Applies a partial set of changes to wp-config.php. `changes` is a map of
// constant -> value (booleans for toggles, 'all'|'minor'|'disabled' for auto
// updates). Unknown keys are ignored.
function setWpConfig(sitePath, changes = {}) {
  if (!fs.existsSync(path.join(sitePath, 'wp-config.php'))) {
    throw new Error('wp-config.php not found for this site.');
  }

  // Safety net: enabling a dependent constant (e.g. WP_DEBUG_LOG) is a no-op in
  // WordPress unless its dependency (WP_DEBUG) is also on. If the caller enabled
  // a dependent without turning the dependency on, enable it too so the toggle
  // actually takes effect.
  const merged = { ...changes };
  for (const setting of WP_CONFIG_SETTINGS) {
    if (setting.dependsOn && merged[setting.key] === true) {
      if (merged[setting.dependsOn] !== true) merged[setting.dependsOn] = true;
    }
  }
  changes = merged;

  for (const [key, value] of Object.entries(changes)) {
    const setting = WP_CONFIG_SETTINGS.find((s) => s.key === key);
    if (!setting) continue;

    if (setting.type === 'bool') {
      wp(
        ['config', 'set', key, value ? 'true' : 'false', '--raw', '--type=constant'],
        sitePath
      );
    }
  }
}

function getWpConfigSchema() {
  return WP_CONFIG_SETTINGS;
}

// Raw wp-config.php contents, for the "Edit Manually" view.
function getWpConfigRaw(sitePath) {
  const file = path.join(sitePath, 'wp-config.php');
  if (!fs.existsSync(file)) throw new Error('wp-config.php not found for this site.');
  return fs.readFileSync(file, 'utf8');
}

// Overwrites wp-config.php, keeping a one-off .bak so a bad manual edit can be
// recovered. Rejects content that doesn't look like a PHP file.
function saveWpConfigRaw(sitePath, contents) {
  const file = path.join(sitePath, 'wp-config.php');
  if (!fs.existsSync(file)) throw new Error('wp-config.php not found for this site.');
  if (typeof contents !== 'string' || !contents.trimStart().startsWith('<?php')) {
    throw new Error('wp-config.php must start with <?php.');
  }
  fs.copyFileSync(file, `${file}.bak`);
  fs.writeFileSync(file, contents, 'utf8');
}

// ─── WordPress overview (core / plugins / themes / users) ──────────────────

function parseJsonList(raw) {
  try {
    const data = JSON.parse(raw.slice(raw.indexOf('[')));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// Gathers everything the site's WordPress overview screen shows, in parallel:
// core version + available core update, plugin/theme inventories with pending
// updates, and the user count.
async function getWpOverview(sitePath) {
  if (!fs.existsSync(path.join(sitePath, 'wp-config.php'))) {
    throw new Error('wp-config.php not found for this site.');
  }

  const listFields = '--fields=name,title,status,version,update,update_version';
  const [coreVersion, coreCheckRaw, pluginsRaw, themesRaw, userCountRaw] =
    await Promise.all([
      wpAsync(['core', 'version'], sitePath),
      // Exits non-zero / prints nothing when already at the latest version.
      wpAsync(['core', 'check-update', '--format=json'], sitePath).catch(() => ''),
      wpAsync(['plugin', 'list', listFields, '--format=json'], sitePath),
      wpAsync(['theme', 'list', listFields, '--format=json'], sitePath),
      wpAsync(['user', 'list', '--format=count'], sitePath).catch(() => ''),
    ]);

  const plugins = parseJsonList(pluginsRaw);
  const themes = parseJsonList(themesRaw);

  // Highest available core version (check-update can list minor + major).
  const coreUpdates = parseJsonList(coreCheckRaw)
    .map((u) => u.version)
    .filter((v) => /^\d+\.\d+(?:\.\d+)*$/.test(v || ''))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

  const toUpdateRow = (item, type) => ({
    name: item.name,
    title: item.title || item.name,
    type,
    version: item.version,
    latest: item.update_version || null,
  });

  const updates = [
    ...plugins
      .filter((p) => p.update === 'available')
      .map((p) => toUpdateRow(p, 'plugin')),
    ...themes.filter((t) => t.update === 'available').map((t) => toUpdateRow(t, 'theme')),
  ];

  return {
    core: {
      version: sanitizeWpVersion(coreVersion) || coreVersion,
      updateVersion: coreUpdates[0] || null,
    },
    counts: {
      plugins: plugins.length,
      themes: themes.length,
      users: parseInt(userCountRaw, 10) || 0,
      pluginUpdates: updates.filter((u) => u.type === 'plugin').length,
      themeUpdates: updates.filter((u) => u.type === 'theme').length,
    },
    updates,
    syncedAt: new Date().toISOString(),
  };
}

// Minimal HTML → text for WP-CLI list output (descriptions/authors carry
// markup like <strong> and <cite>).
function stripHtml(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&#8217;/g, "'")
    .replace(/&quot;|&#8220;|&#8221;/g, '"')
    .replace(/&hellip;/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
}

const WP_ITEM_NAME_RE = /^[a-zA-Z0-9._-]+$/;

// Full plugin inventory for the management screen. Excludes must-use plugins
// and drop-ins — they have no activate/deactivate/update lifecycle.
//
// Not every WordPress/WP-CLI combination exposes the same list fields (e.g.
// `author` is missing on some versions and makes the whole command fail with
// "Invalid field"), so degrade through progressively smaller field sets.
const ITEM_LIST_FIELDS = [
  'name,title,status,version,update,update_version,auto_update,description,author',
  'name,title,status,version,update,update_version,auto_update,description',
  'name,title,status,version,update,update_version',
  'name,status,version,update',
];

// Shared plugin/theme inventory fetch with the field-fallback chain.
async function listWpItems(sitePath, kind) {
  let raw = null;
  let lastErr = null;
  for (const fields of ITEM_LIST_FIELDS) {
    try {
      raw = await wpAsync(
        [kind, 'list', `--fields=${fields}`, '--format=json'],
        sitePath
      );
      break;
    } catch (err) {
      lastErr = err;
      const text = `${err.stderr || ''}${err.message || ''}`;
      // Only retry with fewer fields when the failure is about the fields.
      if (!/invalid field/i.test(text)) throw err;
    }
  }
  if (raw == null) throw lastErr;

  return parseJsonList(raw).map((p) => ({
    name: p.name,
    title: stripHtml(p.title) || p.name,
    status: p.status,
    version: p.version,
    updateAvailable: p.update === 'available',
    updateVersion: p.update_version || null,
    autoUpdate: p.auto_update === 'on',
    description: stripHtml(p.description),
    author: stripHtml(p.author),
  }));
}

async function listPlugins(sitePath) {
  const items = await listWpItems(sitePath, 'plugin');
  return items.filter((p) => p.status !== 'must-use' && p.status !== 'dropin');
}

// Theme inventory. Status is 'active', 'inactive', or 'parent' (parent theme
// of the active child theme).
async function listThemes(sitePath) {
  return listWpItems(sitePath, 'theme');
}

// Runs a lifecycle action on one plugin. Delete deactivates first so hooks
// (e.g. custom tables cleanup on deactivate) get a chance to run.
async function pluginAction(sitePath, action, name) {
  if (typeof name !== 'string' || !WP_ITEM_NAME_RE.test(name)) {
    throw new Error('Invalid plugin name.');
  }
  switch (action) {
    case 'activate':
      await wpAsync(['plugin', 'activate', name], sitePath, { timeout: 300000 });
      break;
    case 'deactivate':
      await wpAsync(['plugin', 'deactivate', name], sitePath, { timeout: 300000 });
      break;
    case 'update':
      await wpAsync(['plugin', 'update', name], sitePath, { timeout: 600000 });
      break;
    case 'delete':
      await wpAsync(['plugin', 'deactivate', name], sitePath, {
        timeout: 300000,
      }).catch(() => {});
      await wpAsync(['plugin', 'delete', name], sitePath, { timeout: 300000 });
      break;
    default:
      throw new Error(`Unknown plugin action: ${action}`);
  }
}

async function setPluginAutoUpdate(sitePath, name, enabled) {
  if (typeof name !== 'string' || !WP_ITEM_NAME_RE.test(name)) {
    throw new Error('Invalid plugin name.');
  }
  await wpAsync(
    ['plugin', 'auto-updates', enabled ? 'enable' : 'disable', name],
    sitePath,
    { timeout: 120000 }
  );
}

// Installs a plugin from the wordpress.org directory by slug.
async function installPlugin(sitePath, slug, activate = false) {
  if (typeof slug !== 'string' || !/^[a-z0-9-]+$/.test(slug)) {
    throw new Error(
      'Invalid plugin slug. Use the wordpress.org slug, e.g. "woocommerce".'
    );
  }
  const args = ['plugin', 'install', slug];
  if (activate) args.push('--activate');
  await wpAsync(args, sitePath, { timeout: 600000 });
}

// Runs a lifecycle action on one theme. Themes have no deactivate — activating
// another theme replaces the current one — and WP-CLI refuses to delete the
// active theme, which surfaces as a normal error.
async function themeAction(sitePath, action, name) {
  if (typeof name !== 'string' || !WP_ITEM_NAME_RE.test(name)) {
    throw new Error('Invalid theme name.');
  }
  switch (action) {
    case 'activate':
      await wpAsync(['theme', 'activate', name], sitePath, { timeout: 300000 });
      break;
    case 'update':
      await wpAsync(['theme', 'update', name], sitePath, { timeout: 600000 });
      break;
    case 'delete':
      await wpAsync(['theme', 'delete', name], sitePath, { timeout: 300000 });
      break;
    default:
      throw new Error(`Unknown theme action: ${action}`);
  }
}

async function setThemeAutoUpdate(sitePath, name, enabled) {
  if (typeof name !== 'string' || !WP_ITEM_NAME_RE.test(name)) {
    throw new Error('Invalid theme name.');
  }
  await wpAsync(
    ['theme', 'auto-updates', enabled ? 'enable' : 'disable', name],
    sitePath,
    { timeout: 120000 }
  );
}

// Installs a theme from the wordpress.org directory by slug.
async function installTheme(sitePath, slug, activate = false) {
  if (typeof slug !== 'string' || !/^[a-z0-9-]+$/.test(slug)) {
    throw new Error('Invalid theme slug. Use the wordpress.org slug, e.g. "astra".');
  }
  const args = ['theme', 'install', slug];
  if (activate) args.push('--activate');
  await wpAsync(args, sitePath, { timeout: 600000 });
}

// Updates WordPress core (plus the DB schema step core updates may need).
async function updateWpCore(sitePath) {
  await wpAsync(['core', 'update'], sitePath, { timeout: 600000 });
  await wpAsync(['core', 'update-db'], sitePath, { timeout: 300000 }).catch(() => {});
}

// Updates a single plugin or theme by slug.
async function updateWpItem(sitePath, type, name) {
  if (type !== 'plugin' && type !== 'theme') {
    throw new Error('Invalid update type.');
  }
  if (typeof name !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error('Invalid plugin/theme name.');
  }
  await wpAsync([type, 'update', name], sitePath, { timeout: 600000 });
}

// Updates every plugin and theme with a pending update.
async function updateWpAll(sitePath) {
  await wpAsync(['plugin', 'update', '--all'], sitePath, { timeout: 900000 });
  await wpAsync(['theme', 'update', '--all'], sitePath, { timeout: 900000 });
}

function getWordPressInfo(sitePath) {
  if (!fs.existsSync(path.join(sitePath, 'wp-config.php'))) {
    return null;
  }
  try {
    const version = sanitizeWpVersion(wp(['core', 'version'], sitePath));
    const siteUrl = wp(['option', 'get', 'siteurl'], sitePath);
    return { version, siteUrl };
  } catch {
    return null;
  }
}

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function sanitizeDomain(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function sanitizeDbName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

module.exports = {
  DEFAULT_SITES_DIR,
  getWpCliBin,
  wp,
  wpAsync,
  createWordPressSite,
  removeWordPressSite,
  setSiteUrl,
  selectExistingPlugins,
  restoreWpressActiveState,
  ensureTunnelMuPlugin,
  listAdminUsers,
  ensureMagicLoginMuPlugin,
  removeMagicLoginMuPlugin,
  getWpConfigSchema,
  getWpConfig,
  setWpConfig,
  getWpConfigRaw,
  saveWpConfigRaw,
  getWpOverview,
  updateWpCore,
  updateWpItem,
  updateWpAll,
  listPlugins,
  pluginAction,
  setPluginAutoUpdate,
  installPlugin,
  listThemes,
  themeAction,
  setThemeAutoUpdate,
  installTheme,
  getSiteWordPressVersion,
  getWordPressInfo,
  sanitizeDomain,
  sanitizeDbName,
  generateId,
};
