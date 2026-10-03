'use strict';

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const brew = require('./brew.cjs');
const execAsync = require('./asyncExec.cjs');
const procman = require('./procman.cjs');

// PHP versions WPXen can install. Newer versions ship as Homebrew core
// formulae (php@<version>); older EOL versions were dropped from core and come
// from the community shivammathur/php tap instead. Newest first, and kept in
// sync with the versions probed by brew.getInstalledPhpVersions.
const CORE_PHP_VERSIONS = ['8.4', '8.3', '8.2', '8.1'];
const TAP_PHP_VERSIONS = ['8.0', '7.4'];
const KNOWN_PHP_VERSIONS = [...CORE_PHP_VERSIONS, ...TAP_PHP_VERSIONS];

// Returns the Homebrew formula spec to install a given version. Core versions
// use the short name; tap versions use the fully-qualified name so `brew
// install` auto-taps shivammathur/php.
function installFormulaFor(version) {
  return TAP_PHP_VERSIONS.includes(version)
    ? `shivammathur/php/php@${version}`
    : `php@${version}`;
}

// The keg that really is `version` — php@X, or the unversioned `php` formula
// when that's the version it currently tracks. Never the linked `{prefix}/bin`
// copy: that's whichever version is active, and with one FPM per version a
// fallback to it would silently serve a site on the wrong PHP.
function phpKegDir(version) {
  const prefix = brew.getBrewPrefix();
  const formula = prefix && brew.phpFormulaForVersion(version);
  return formula ? `${prefix}/opt/${formula}` : null;
}

function getPhpBinPath(version) {
  const keg = phpKegDir(version);
  const bin = keg && `${keg}/bin/php`;
  return bin && fs.existsSync(bin) ? bin : null;
}

function getPhpFpmBinPath(version) {
  const keg = phpKegDir(version);
  const bin = keg && `${keg}/sbin/php-fpm`;
  return bin && fs.existsSync(bin) ? bin : null;
}

function getBrewServiceName(version) {
  // Resolve the real formula (php vs php@X) by the binary's actual version, not
  // the opt symlink — a stale symlink (e.g. opt/php@8.5 -> php 8.5) would
  // otherwise yield a non-existent service name like "php@8.5" and the real
  // `php` service would never start/stop.
  return brew.phpFormulaForVersion(version) || 'php';
}

// ─── PHP-FPM: one supervised child per version ─────────────────────────────
//
// Each PHP version a Site uses runs its own php-fpm, supervised by procman in
// slot `php@<version>`, listening on its own unix socket that the Site's vhost
// points at. WPXen writes its own FPM config per version rather than using
// Homebrew's php-fpm.conf, whose www pool binds 127.0.0.1:9000 for *every*
// version — that shared port is why per-site PHP used to have no effect, and
// why a user's own `brew services start php` used to collide with ours.
//
// php.ini and conf.d still load (they're per-keg, not per-FPM-config), so
// zz-wpxen.ini and the Mailpit sendmail_path override keep applying.

// Names that carry the app's name outside its bundle (see CLAUDE.md, "Legacy
// names") — a future rename has to find and migrate these.
const FPM_CONFIG_NAME = 'wpxen-fpm.conf'; // {prefix}/etc/php/<version>/
const FPM_RUN_DIR = 'wpxen'; // {prefix}/var/run/<dir>/ — sockets
const FPM_POOL_PREFIX = 'wpxen'; // [wpxen-<version>] pool name

// The procman slot of the single-FPM era. Only ever stopped now.
const LEGACY_FPM_SLOT = 'php';

function fpmSlot(version) {
  return `php@${version}`;
}

function fpmConfigPath(version, prefix = brew.getBrewPrefix()) {
  return prefix ? `${prefix}/etc/php/${version}/${FPM_CONFIG_NAME}` : null;
}

// Where `version`'s FPM listens — deterministic, so nginx can point a vhost at
// it before the FPM is up. Under the Homebrew prefix, not userData:
// "Application Support" has a space, which `fastcgi_pass unix:…` can't take.
function fpmSocketPath(version, prefix = brew.getBrewPrefix()) {
  return prefix ? `${prefix}/var/run/${FPM_RUN_DIR}/php${version}.sock` : null;
}

// The FPM config WPXen runs `version` with. Pure, so it's testable. Pool
// sizing matches Homebrew's www.conf; the log stays where FPM writes it by
// default, which is what the Logs page reads.
function buildFpmConfig({ version, prefix }) {
  return [
    '; Managed by WPXen — rewritten every time this PHP version starts.',
    '; Edit PHP settings from the app; changes here are overwritten.',
    '',
    '[global]',
    `pid = ${prefix}/var/run/${FPM_RUN_DIR}/php${version}-fpm.pid`,
    `error_log = ${prefix}/var/log/php-fpm.log`,
    'daemonize = no',
    '',
    `[${FPM_POOL_PREFIX}-${version}]`,
    `listen = ${fpmSocketPath(version, prefix)}`,
    'listen.mode = 0660',
    'pm = dynamic',
    'pm.max_children = 5',
    'pm.start_servers = 2',
    'pm.min_spare_servers = 1',
    'pm.max_spare_servers = 3',
    '',
  ].join('\n');
}

function writeFpmConfig(version) {
  const prefix = brew.getBrewPrefix();
  if (!prefix) throw new Error('Homebrew not found');
  fs.mkdirSync(`${prefix}/var/run/${FPM_RUN_DIR}`, { recursive: true });
  fs.writeFileSync(fpmConfigPath(version, prefix), buildFpmConfig({ version, prefix }));
}

// Matches WPXen's php-fpm master for one version (or any version), by the
// config path it was started with — so Herd's or a user's own brew-services
// php-fpm never reads as ours.
function fpmMasterPattern(version) {
  const prefix = brew.getBrewPrefix();
  if (!prefix) return null;
  const v = version ? version.replace('.', '\\.') : '[0-9.]+';
  return `php-fpm: master.*${prefix}/etc/php/${v}/${FPM_CONFIG_NAME}`;
}

function isPhpFpmRunning(version) {
  const pattern = fpmMasterPattern(version);
  if (!pattern) return false;
  try {
    return (
      execFileSync('pgrep', ['-f', pattern], { stdio: 'pipe' }).toString().trim() !== ''
    );
  } catch {
    return false;
  }
}

// Non-blocking variant used by the status poller (see asyncExec.cjs). With no
// version: is any of WPXen's FPMs up.
async function isPhpFpmRunningAsync(version) {
  const pattern = fpmMasterPattern(version);
  if (!pattern) return false;
  try {
    await execAsync(`pgrep -f ${JSON.stringify(pattern)}`, { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

// Ready once the socket accepts a connection — the thing nginx needs.
function socketAccepts(socketPath) {
  return new Promise((resolve) => {
    const conn = net.connect(socketPath);
    const done = (ok) => {
      conn.destroy();
      resolve(ok);
    };
    conn.once('connect', () => done(true));
    conn.once('error', () => done(false));
    conn.setTimeout(1000, () => done(false));
  });
}

function buildFpmSpec(version) {
  const bin = getPhpFpmBinPath(version);
  if (!bin) throw new Error(`PHP ${version} is not installed`);
  const prefix = brew.getBrewPrefix();
  const socket = fpmSocketPath(version, prefix);
  return {
    name: fpmSlot(version),
    bin,
    args: ['--nodaemonize', '--fpm-config', fpmConfigPath(version, prefix)],
    cwd: `${prefix}/var`,
    stopSignal: 'SIGQUIT', // graceful: workers finish in-flight requests
    stopTimeoutMs: 10_000,
    meta: { version },
    preSpawn: async () => {
      // Our config, current every start (it carries the socket path).
      writeFpmConfig(version);
      // A SIGKILLed master orphans its pool workers (reparented to launchd);
      // sweep this version's, then drop a stale socket so the bind succeeds.
      const pool = `php-fpm: pool ${FPM_POOL_PREFIX}-${version}`;
      try {
        await execAsync(
          `ps -axo pid=,ppid=,command= | awk '$2==1 && index($0, ${JSON.stringify(pool)}) {print $1}' | xargs kill -9`,
          { timeout: 4000 }
        );
      } catch {}
      try {
        fs.rmSync(socket, { force: true });
      } catch {}
    },
    readyProbe: () => socketAccepts(socket),
    readyTimeoutMs: 10_000,
  };
}

// Seams for tests — vi.mock can't reach CJS modules (see browser.cjs).
let overrides = {};
// Sites, for reconcile. ipc.cjs registers the store; php.cjs stays store-free.
let sitesProvider = () => [];

const deps = {
  get procman() {
    return 'procman' in overrides ? overrides.procman : procman;
  },
  get fpmSpec() {
    return 'fpmSpec' in overrides ? overrides.fpmSpec : buildFpmSpec;
  },
  get linkPhp() {
    return 'linkPhp' in overrides ? overrides.linkPhp : switchActivePhpVersion;
  },
  get activePhpVersion() {
    return 'activePhpVersion' in overrides
      ? overrides.activePhpVersion
      : () => brew.getActivePhpVersion();
  },
  get installedVersions() {
    return 'installedVersions' in overrides
      ? overrides.installedVersions
      : () => brew.getInstalledPhpVersions();
  },
  get sites() {
    return 'sites' in overrides ? overrides.sites : sitesProvider;
  },
};

function __setDeps(next) {
  overrides = { ...overrides, ...next };
}

function setSitesProvider(fn) {
  sitesProvider = typeof fn === 'function' ? fn : () => [];
}

function isUp(version) {
  const { state } = deps.procman.status(fpmSlot(version));
  return state === 'running' || state === 'starting';
}

// The versions whose FPM is up (or coming up), in installed order.
function getRunningFpmVersions() {
  return deps.installedVersions().filter(isUp);
}

// The PHP-FPM service as the UI sees it: one logical service made of a
// supervised child per version. `state` is the most urgent of the versions'
// (a failed one first, so its error surfaces), and `versions` lists the ones
// up or coming up. Versions never started this session are left out.
function getFpmStatus() {
  const entries = deps.installedVersions().map((version) => {
    const st = deps.procman.status(fpmSlot(version));
    return { version, state: st.state, error: st.error || null };
  });
  const by = (state) => entries.filter((e) => e.state === state);
  const failed = by('failed');
  const state = failed.length
    ? 'failed'
    : by('running').length
      ? 'running'
      : by('starting').length
        ? 'starting'
        : 'stopped';
  return {
    state,
    error: failed.length ? `PHP ${failed[0].version}: ${failed[0].error}` : null,
    managed: entries.some((e) => deps.procman.isSupervised(fpmSlot(e.version))),
    versions: entries
      .filter((e) => e.state === 'running' || e.state === 'starting')
      .map((e) => e.version),
  };
}

// Which versions should be running: every installed version a Site uses, plus
// the active one (phpMyAdmin runs on it). Pure.
function neededPhpVersions(sites, activeVersion, installed) {
  const have = new Set(installed);
  const wanted = new Set(
    (sites || []).map((s) => s && s.phpVersion).filter((v) => v && have.has(v))
  );
  if (activeVersion && have.has(activeVersion)) wanted.add(activeVersion);
  return installed.filter((v) => wanted.has(v));
}

function startPhpFpm(version) {
  return deps.procman.start(deps.fpmSpec(version));
}

// Starts `version`'s FPM unless it's already up — for flows that point a vhost
// at a version and need it serving now, not after the next reconcile.
async function ensurePhpFpm(version) {
  if (version && !isUp(version)) await startPhpFpm(version);
}

function stopPhpFpm(version) {
  return deps.procman.stop(fpmSlot(version));
}

async function stopAllPhpFpm() {
  await Promise.all([
    ...deps.installedVersions().map(stopPhpFpm),
    deps.procman.stop(LEGACY_FPM_SLOT),
  ]);
}

// Brings the running set in line with neededPhpVersions: starts what's
// missing, stops what no Site (and not phpMyAdmin) uses. A version that fails
// to start doesn't stop the others; its error is collected and returned.
// Serialized — two overlapping reconciles would race on the same slots.
let reconcileChain = Promise.resolve();
function reconcilePhpFpm() {
  const run = async () => {
    const installed = deps.installedVersions();
    const needed = neededPhpVersions(deps.sites(), deps.activePhpVersion(), installed);
    const errors = [];
    for (const v of needed) {
      if (isUp(v)) continue;
      try {
        await startPhpFpm(v);
      } catch (err) {
        errors.push({ version: v, error: err.message });
      }
    }
    for (const v of installed) {
      if (!needed.includes(v) && isUp(v)) await stopPhpFpm(v);
    }
    return { needed, errors };
  };
  const result = reconcileChain.then(run, run);
  reconcileChain = result.catch(() => {});
  return result;
}

// Makes `version` the active PHP: the CLI `php` link and the FPM phpMyAdmin
// runs on. It never moves a Site — each keeps its own version — and nothing
// is stopped first, so sites stay up whatever happens. If the new version's
// FPM won't start, the CLI link goes back so "active" stays truthful.
async function switchPhpVersion(version) {
  const previousLink = deps.activePhpVersion();
  deps.linkPhp(version);
  try {
    if (!isUp(version)) await startPhpFpm(version);
  } catch (err) {
    if (previousLink && previousLink !== version) {
      try {
        deps.linkPhp(previousLink);
      } catch {}
    }
    throw err;
  }
  // The old active version may no longer be needed by any Site.
  await reconcilePhpFpm();
}

function getPhpVersion(version) {
  const phpBin = getPhpBinPath(version);
  if (!phpBin) return null;
  try {
    return execSync(`${phpBin} -r "echo phpversion();"`, { stdio: 'pipe' })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

// Non-blocking variant used by the PHP page (see asyncExec.cjs).
async function getPhpVersionAsync(version) {
  const phpBin = getPhpBinPath(version);
  if (!phpBin) return null;
  try {
    const { stdout } = await execAsync(`${phpBin} -r "echo phpversion();"`, {
      timeout: 4000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function getInstalledPhpVersionsWithDetails() {
  const versions = brew.getInstalledPhpVersions();
  const activeVersion = brew.getActivePhpVersion();

  return versions.map((v) => ({
    version: v,
    fullVersion: getPhpVersion(v) || v,
    active: v === activeVersion,
    running: isUp(v),
    socketPath: fpmSocketPath(v),
  }));
}

// Non-blocking variant used by the get-php-versions IPC handler. Probes every
// version's full number and FPM state in parallel so opening the PHP page
// doesn't freeze the main thread.
async function getInstalledPhpVersionsWithDetailsAsync() {
  const prefix = brew.getBrewPrefix();
  const versions = brew.getInstalledPhpVersions();
  const [activeVersion, outdated] = await Promise.all([
    brew.getActivePhpVersionAsync(),
    brew.getOutdatedFormulae(),
  ]);

  const fullVersions = await Promise.all(versions.map((v) => getPhpVersionAsync(v)));

  return versions.map((v, i) => {
    // The formula name (php vs php@X) as brew reports it in `outdated`.
    const formula =
      prefix && fs.existsSync(`${prefix}/Cellar/php@${v}`) ? `php@${v}` : 'php';
    return {
      version: v,
      fullVersion: fullVersions[i] || v,
      active: v === activeVersion,
      // Each version has its own supervised FPM, so this is per version.
      running: isUp(v),
      outdated: outdated.has(formula),
      socketPath: fpmSocketPath(v),
    };
  });
}

// Lists PHP versions WPXen can install via Homebrew, each flagged with whether
// it's already installed. Any installed version not in the known list (e.g. a
// newer release from a tap) is appended so nothing installed is ever hidden.
function getInstallablePhpVersions() {
  const installed = new Set(brew.getInstalledPhpVersions());
  const versions = [...new Set([...KNOWN_PHP_VERSIONS, ...installed])];
  return versions
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((version) => ({ version, installed: installed.has(version) }));
}

// Homebrew 6.0 turned on HOMEBREW_REQUIRE_TAP_TRUST by default, so it refuses
// to load formulae from untrusted third-party taps — which breaks install and
// upgrade of the EOL PHP versions WPXen pulls from shivammathur/php (they fail
// with "the following taps are not trusted"). `brew tap` clones the repo and
// `brew trust` whitelists it in trust.json; both are idempotent, and on older
// Homebrew that lacks `brew trust` the failure is swallowed (trust isn't
// required there, so the install/upgrade below still runs and surfaces any
// real error itself).
const WPXEN_PHP_TAP = 'shivammathur/php';

async function ensurePhpTapTrusted(onProgress) {
  // Tap must exist before it can be trusted or its formulae loaded.
  await brew.runBrewStreaming(['tap', WPXEN_PHP_TAP], onProgress).catch(() => {});
  await brew.runBrewStreaming(['trust', WPXEN_PHP_TAP], onProgress).catch(() => {});
}

// Installs a PHP version via Homebrew (core or the shivammathur/php tap).
async function installPhpVersion(version, onProgress) {
  if (!/^\d+\.\d+$/.test(String(version))) {
    throw new Error('Invalid PHP version');
  }
  if (TAP_PHP_VERSIONS.includes(version)) {
    await ensurePhpTapTrusted(onProgress);
  }
  return brew.runBrewStreaming(['install', installFormulaFor(version)], onProgress);
}

// Upgrades an installed PHP version to its latest patch release.
async function updatePhpVersion(version, onProgress) {
  if (!/^\d+\.\d+$/.test(String(version))) {
    throw new Error('Invalid PHP version');
  }
  const formula = brew.phpFormulaForVersion(version);
  if (!formula) {
    throw new Error(`PHP ${version} is not installed`);
  }
  // php@7.4 / php@8.0 live in the untrusted shivammathur/php tap; trust it
  // first or Homebrew 6.0 refuses to load the formula for the upgrade.
  if (TAP_PHP_VERSIONS.includes(version)) {
    await ensurePhpTapTrusted(onProgress);
  }
  return brew.runBrewStreaming(['upgrade', formula], onProgress);
}

function switchActivePhpVersion(version) {
  const prefix = brew.getBrewPrefix();
  if (!prefix) throw new Error('Homebrew not found');

  // Resolve the real formula for this version up front (php@X vs the
  // unversioned php), so we fail cleanly instead of trying to link a
  // non-existent keg via a stale opt symlink.
  const targetFormula = brew.phpFormulaForVersion(version);
  if (!targetFormula) {
    throw new Error(`PHP ${version} is not installed`);
  }

  // Unlink every installed php formula (best-effort) before linking the target.
  try {
    brew.execBrew('unlink php');
  } catch {}
  for (const v of brew.getInstalledPhpVersions()) {
    try {
      brew.execBrew(`unlink php@${v}`);
    } catch {}
  }

  brew.execBrew(`link --overwrite --force ${targetFormula}`);
}

// ─── php.ini settings ──────────────────────────────────────────────────────
//
// Editable php.ini directives, exposed per installed version. We never touch the
// user's php.ini; instead we write a WPXen-managed override into that version's
// conf.d directory (loaded last, so it wins). Each setting stores a single plain
// number that maps to one or more directives.
const PHP_INI_SETTINGS = [
  {
    key: 'upload_max_filesize',
    label: 'Max File Upload Size',
    unit: 'MB',
    description: 'Maximum file size that PHP will accept as file uploads (in MB).',
    default: 128,
    toDirectives: (v) => ({
      upload_max_filesize: `${v}M`,
      post_max_size: `${v}M`,
    }),
  },
  {
    key: 'memory_limit',
    label: 'Memory Limit',
    unit: 'MB',
    description:
      'Maximum amount of memory your PHP scripts may consume (in MB). -1 for unlimited.',
    default: 512,
    toDirectives: (v) => ({ memory_limit: v === -1 ? '-1' : `${v}M` }),
  },
  {
    key: 'max_execution_time',
    label: 'Max Execution Time',
    unit: 'seconds',
    description: 'Maximum time in seconds a script is allowed to run.',
    default: 60,
    toDirectives: (v) => ({ max_execution_time: `${v}` }),
  },
];

// ─── Per-site PHP settings ──────────────────────────────────────────────────
//
// Site-specific overrides applied through the site's nginx vhost via
// `fastcgi_param PHP_VALUE` (all of these directives are PHP_INI_PERDIR or
// PHP_INI_ALL, so FPM honours them per request). They take precedence over the
// global php.ini and the WPXen-managed conf.d file — for this site only.
const SITE_PHP_SETTINGS = [
  {
    key: 'memory_limit',
    label: 'PHP Memory Limit',
    unit: 'MB',
    default: 256,
    description:
      'Maximum amount of memory a script may consume for this site. -1 for unlimited.',
    toDirectives: (v) => ({ memory_limit: v === -1 ? '-1' : `${v}M` }),
  },
  {
    key: 'max_execution_time',
    label: 'Max Execution Time',
    unit: 'Seconds',
    default: 60,
    description:
      'Maximum time in seconds that a script is allowed to run before it is terminated.',
    toDirectives: (v) => ({ max_execution_time: `${v}` }),
  },
  {
    key: 'max_file_uploads',
    label: 'Max File Upload',
    unit: null,
    default: 20,
    description: 'Maximum number of files that can be uploaded at once.',
    toDirectives: (v) => ({ max_file_uploads: `${v}` }),
  },
  {
    key: 'upload_max_filesize',
    label: 'Max File Upload Size',
    unit: 'MB',
    default: 100,
    description: 'Maximum file size that can be uploaded.',
    toDirectives: (v) => ({
      upload_max_filesize: `${v}M`,
      post_max_size: `${v}M`,
    }),
  },
  {
    key: 'max_input_time',
    label: 'Max Input Time',
    unit: 'Seconds',
    default: 60,
    description: 'Maximum time in seconds that a script is allowed to parse input data.',
    toDirectives: (v) => ({ max_input_time: `${v}` }),
  },
  {
    key: 'max_input_vars',
    label: 'Max Input Vars',
    unit: null,
    default: 1000,
    description: 'Maximum number of input variables that can be accepted.',
    toDirectives: (v) => ({ max_input_vars: `${v}` }),
  },
];

// Validates a raw per-site settings object, returning a clean {key: int} map
// containing only known keys. Throws on non-numeric or out-of-range values.
function validateSitePhpSettings(raw = {}) {
  const clean = {};
  for (const s of SITE_PHP_SETTINGS) {
    if (raw[s.key] == null || raw[s.key] === '') continue;
    const num = parseInt(raw[s.key], 10);
    if (Number.isNaN(num)) throw new Error(`${s.label} must be a number.`);
    if (s.key === 'memory_limit') {
      if (num !== -1 && num < 1) {
        throw new Error('Memory limit must be a positive number, or -1 for unlimited.');
      }
    } else if (num < 1) {
      throw new Error(`${s.label} must be at least 1.`);
    }
    if (num > 1_000_000) throw new Error(`${s.label} value is too large.`);
    clean[s.key] = num;
  }
  return clean;
}

// Builds the newline-separated directive list for `fastcgi_param PHP_VALUE`
// from a validated per-site settings map. Returns null when nothing is set.
function buildSitePhpValue(settings = {}) {
  const lines = [];
  for (const s of SITE_PHP_SETTINGS) {
    const v = settings[s.key];
    if (v == null) continue;
    if (!Number.isInteger(v)) continue; // only validated integers reach nginx
    for (const [directive, val] of Object.entries(s.toDirectives(v))) {
      lines.push(`${directive}=${val}`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

// Parses a php.ini shorthand size ("128M", "1G", "-1", bytes) into whole MB.
function iniSizeToMB(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*([KMG])?$/i);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (num === -1) return -1;
  const unit = (m[2] || '').toUpperCase();
  if (unit === 'G') return Math.round(num * 1024);
  if (unit === 'M') return Math.round(num);
  if (unit === 'K') return Math.max(1, Math.round(num / 1024));
  // Bare number = bytes.
  return Math.max(1, Math.round(num / (1024 * 1024)));
}

// Reads the *global* effective values for the per-site settings from a PHP
// version's configuration — what FPM applies when a site has no override.
// ini_get() covers most keys, but the CLI SAPI force-overrides the time
// directives (max_execution_time -> 0, max_input_time -> -1) at startup, so
// those are re-read from the ini file chain (php.ini + conf.d scan dir — the
// same files FPM loads). Falls back to schema defaults on any failure.
function getGlobalSitePhpValues(version) {
  const values = {};
  for (const s of SITE_PHP_SETTINGS) values[s.key] = s.default;

  const phpBin = getPhpBinPath(version);
  if (!phpBin) return values;

  const keys = SITE_PHP_SETTINGS.map((s) => s.key);
  const script = `
    $keys = ${JSON.stringify(keys)};
    $vals = [];
    foreach ($keys as $k) $vals[$k] = ini_get($k);
    $files = [];
    if ($f = php_ini_loaded_file()) $files[] = $f;
    if ($s = php_ini_scanned_files()) {
      foreach (array_map('trim', explode(',', $s)) as $x) if ($x !== '') $files[] = $x;
    }
    $fromIni = [];
    foreach ($files as $f) {
      $arr = @parse_ini_file($f, false, INI_SCANNER_RAW);
      if (is_array($arr)) {
        foreach ($keys as $k) if (array_key_exists($k, $arr)) $fromIni[$k] = $arr[$k];
      }
    }
    foreach (['max_execution_time', 'max_input_time'] as $k) {
      if (isset($fromIni[$k])) $vals[$k] = $fromIni[$k];
    }
    echo json_encode($vals);
  `;

  try {
    const out = execFileSync(phpBin, ['-r', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    })
      .toString()
      .trim();
    const raw = JSON.parse(out.slice(out.indexOf('{')));

    for (const s of SITE_PHP_SETTINGS) {
      const v = raw[s.key];
      if (v == null || v === '' || v === false) continue;
      const num = s.unit === 'MB' ? iniSizeToMB(v) : parseInt(v, 10);
      if (num != null && !Number.isNaN(num)) values[s.key] = num;
    }
  } catch {
    // Keep schema defaults.
  }
  return values;
}

function getSitePhpSettingsSchema() {
  return SITE_PHP_SETTINGS.map(({ key, label, unit, default: def, description }) => ({
    key,
    label,
    unit,
    default: def,
    description,
  }));
}

function getManagedIniPath(version) {
  const prefix = brew.getBrewPrefix();
  if (!prefix) return null;
  return `${prefix}/etc/php/${version}/conf.d/zz-wpxen.ini`;
}

// The pre-rename files, newest first. conf.d loads alphabetically and
// zz-wpxen.ini sorts after both, so ours wins on load — but a leftover still
// has to be read once for its customised values, then deleted the moment we
// write our own, or the file lingers forever setting directives nothing owns.
const LEGACY_INI_MARKERS = ['wpdevpilot', 'wpherd'];

function getLegacyManagedIniPaths(version) {
  const prefix = brew.getBrewPrefix();
  if (!prefix) return [];
  return LEGACY_INI_MARKERS.map((marker) => [
    `${prefix}/etc/php/${version}/conf.d/zz-${marker}.ini`,
    marker,
  ]);
}

function removeLegacyManagedIni(version) {
  for (const [legacy] of getLegacyManagedIniPaths(version)) {
    try {
      if (fs.existsSync(legacy)) fs.rmSync(legacy, { force: true });
    } catch {}
  }
}

// Validates a raw input against a setting's rules, returning an integer.
function validateSettingValue(setting, value) {
  const num = parseInt(value, 10);
  if (Number.isNaN(num) || String(value).trim() === '') {
    throw new Error(`${setting.label} must be a number.`);
  }
  if (setting.key === 'memory_limit') {
    if (num !== -1 && num < 1) {
      throw new Error('Memory limit must be a positive number, or -1 for unlimited.');
    }
  } else if (num < 1) {
    throw new Error(`${setting.label} must be at least 1.`);
  }
  if (num > 1_000_000) {
    throw new Error(`${setting.label} value is too large.`);
  }
  return num;
}

// Reads the WPXen-managed values for a version, falling back to defaults for
// any setting that hasn't been customised yet. Values are round-tripped via a
// `; wpxen:<key>=<number>` comment so the plain number survives directive
// formatting (e.g. "128M").
function readManagedValues(version) {
  const values = {};
  for (const s of PHP_INI_SETTINGS) values[s.key] = s.default;

  // Prefer our own file; fall back through the pre-rename ones so a customised
  // value survives the first read after upgrading, whichever name wrote it.
  const candidates = [
    [getManagedIniPath(version), 'wpxen'],
    ...getLegacyManagedIniPaths(version),
  ];
  for (const [p, marker] of candidates) {
    try {
      if (!p || !fs.existsSync(p)) continue;
      const content = fs.readFileSync(p, 'utf8');
      for (const s of PHP_INI_SETTINGS) {
        const m = content.match(new RegExp(`^; ${marker}:${s.key}=(-?\\d+)`, 'm'));
        if (m) values[s.key] = parseInt(m[1], 10);
      }
      break;
    } catch {}
  }
  return values;
}

function writeManagedIni(version, values) {
  const p = getManagedIniPath(version);
  if (!p) throw new Error('Could not resolve the PHP config directory.');
  const dir = p.slice(0, p.lastIndexOf('/'));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const lines = ['; Managed by WPXen — edit these from the app.', ''];
  for (const s of PHP_INI_SETTINGS) {
    const v = values[s.key];
    lines.push(`; wpxen:${s.key}=${v}`);
    for (const [directive, val] of Object.entries(s.toDirectives(v))) {
      lines.push(`${directive} = ${val}`);
    }
    lines.push('');
  }
  fs.writeFileSync(p, lines.join('\n'), 'utf8');
  removeLegacyManagedIni(version);
}

// Reloads `version`'s FPM only if it's running, so a config change takes
// effect without spuriously starting a stopped service. SIGUSR2 is php-fpm's
// graceful reload: workers respawn and re-read php.ini/conf.d with zero
// dropped requests.
function reloadPhpFpmIfRunning(version) {
  try {
    if (isUp(version) && procman.isSupervised(fpmSlot(version))) {
      procman.signal(fpmSlot(version), 'SIGUSR2');
    }
  } catch {}
}

function getPhpIniSettings() {
  const versions = brew.getInstalledPhpVersions();
  return {
    settings: PHP_INI_SETTINGS.map(({ key, label, unit, description, default: def }) => ({
      key,
      label,
      unit,
      description,
      default: def,
    })),
    versions: versions.map((version) => ({
      version,
      values: readManagedValues(version),
    })),
  };
}

function setPhpIniSetting(version, key, value) {
  const setting = PHP_INI_SETTINGS.find((s) => s.key === key);
  if (!setting) throw new Error(`Unknown PHP setting: ${key}`);
  if (!/^\d+\.\d+$/.test(String(version))) throw new Error('Invalid PHP version');
  if (!brew.getInstalledPhpVersions().includes(version)) {
    throw new Error(`PHP ${version} is not installed`);
  }

  const num = validateSettingValue(setting, value);
  const values = readManagedValues(version);
  values[key] = num;
  writeManagedIni(version, values);
  reloadPhpFpmIfRunning(version);
}

function setPhpIniSettingAllVersions(key, value) {
  for (const version of brew.getInstalledPhpVersions()) {
    setPhpIniSetting(version, key, value);
  }
}

module.exports = {
  getPhpBinPath,
  getPhpFpmBinPath,
  isPhpFpmRunning,
  isPhpFpmRunningAsync,
  startPhpFpm,
  stopPhpFpm,
  stopAllPhpFpm,
  getRunningFpmVersions,
  getFpmStatus,
  reconcilePhpFpm,
  ensurePhpFpm,
  neededPhpVersions,
  setSitesProvider,
  fpmSocketPath,
  buildFpmConfig,
  phpKegDir,
  getInstalledPhpVersionsWithDetails,
  getInstalledPhpVersionsWithDetailsAsync,
  getInstallablePhpVersions,
  installPhpVersion,
  updatePhpVersion,
  switchActivePhpVersion,
  switchPhpVersion,
  getBrewServiceName,
  getPhpIniSettings,
  reloadPhpFpmIfRunning,
  setPhpIniSetting,
  setPhpIniSettingAllVersions,
  getSitePhpSettingsSchema,
  getGlobalSitePhpValues,
  validateSitePhpSettings,
  buildSitePhpValue,
  __setDeps,
};
