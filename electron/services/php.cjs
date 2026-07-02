'use strict';

const { execSync, execFileSync, spawn } = require('child_process');
const fs = require('fs');
const brew = require('./brew.cjs');
const execAsync = require('./asyncExec.cjs');
const procman = require('./procman.cjs');

// PHP versions WPHerd can install. Newer versions ship as Homebrew core
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

function getPhpBinPath(version) {
  const prefix = brew.getBrewPrefix();
  if (!prefix) return null;
  // Specific version
  const versionedPath = `${prefix}/opt/php@${version}/bin/php`;
  if (fs.existsSync(versionedPath)) return versionedPath;
  // Default (might match active version)
  const defaultPath = `${prefix}/bin/php`;
  if (fs.existsSync(defaultPath)) return defaultPath;
  return null;
}

function getPhpFpmBinPath(version) {
  const prefix = brew.getBrewPrefix();
  if (!prefix) return null;
  const versionedPath = `${prefix}/opt/php@${version}/sbin/php-fpm`;
  if (fs.existsSync(versionedPath)) return versionedPath;
  const defaultPath = `${prefix}/sbin/php-fpm`;
  if (fs.existsSync(defaultPath)) return defaultPath;
  return null;
}

function getBrewServiceName(version) {
  // Resolve the real formula (php vs php@X) by the binary's actual version, not
  // the opt symlink — a stale symlink (e.g. opt/php@8.5 -> php 8.5) would
  // otherwise yield a non-existent service name like "php@8.5" and the real
  // `php` service would never start/stop.
  return brew.phpFormulaForVersion(version) || 'php';
}

// Match only the php-fpm master that WPHerd manages — its config lives under
// the Homebrew prefix ({prefix}/etc/php/...). This deliberately excludes other
// php-fpm processes on the machine (e.g. Laravel Herd's, whose config is under
// ~/Library/Application Support/Herd), so the status and Stop button reflect
// what WPHerd actually controls.
function phpFpmPgrepPattern() {
  const prefix = brew.getBrewPrefix();
  return prefix ? `php-fpm: master.*${prefix}/etc/php` : null;
}

function isPhpFpmRunning(_version) {
  const pattern = phpFpmPgrepPattern();
  if (!pattern) return false;
  try {
    const out = execFileSync('pgrep', ['-f', pattern], { stdio: 'pipe' })
      .toString()
      .trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

// Non-blocking variant used by the status poller (see asyncExec.cjs).
async function isPhpFpmRunningAsync(_version) {
  const pattern = phpFpmPgrepPattern();
  if (!pattern) return false;
  try {
    await execAsync(`pgrep -f ${JSON.stringify(pattern)}`, { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

// php-fpm runs as a single supervised child of WPHerd (registry slot 'php',
// see procman.cjs) — one version at a time, matching today's behavior: every
// version's pool listens on 127.0.0.1:9000, so two can't coexist anyway.
function buildFpmSpec(version) {
  const bin = getPhpFpmBinPath(version);
  if (!bin) throw new Error(`PHP ${version} is not installed`);
  const prefix = brew.getBrewPrefix();
  return {
    name: 'php',
    bin,
    // Explicit --fpm-config: the unversioned `php` keg's compiled-in default
    // doesn't always match the etc/php/<version> layout brew services used.
    args: [
      '--nodaemonize',
      '--fpm-config',
      `${prefix}/etc/php/${version}/php-fpm.conf`,
    ],
    cwd: `${prefix}/var`,
    stopSignal: 'SIGQUIT', // graceful: workers finish in-flight requests
    stopTimeoutMs: 10_000,
    meta: { version },
    // A SIGKILLed master orphans its pool workers (reparented to launchd),
    // which keep 127.0.0.1:9000 bound — sweep them before every (re)spawn.
    preSpawn: async () => {
      try {
        await execAsync(
          `ps -axo pid=,ppid=,command= | awk '$2==1 && $0 ~ /php-fpm: pool/ {print $1}' | xargs kill -9`,
          { timeout: 4000 }
        );
      } catch {}
    },
    readyProbe: () => isPhpFpmRunningAsync(),
    readyTimeoutMs: 10_000,
    // A pre-migration launchd instance may still hold :9000 — clear it.
    conflictProbe: () => isPhpFpmRunningAsync(),
    takeover: async () => {
      for (const v of brew.getInstalledPhpVersions()) {
        try {
          brew.stopBrewService(getBrewServiceName(v));
        } catch {}
      }
    },
  };
}

// The version the supervised FPM child is currently running, or null.
function getRunningFpmVersion() {
  const st = procman.status('php');
  if (st.state === 'running' || st.state === 'starting') {
    return st.meta?.version ?? null;
  }
  return null;
}

async function startPhpFpm(version) {
  const running = getRunningFpmVersion();
  if (running && running !== version) {
    await procman.stop('php');
  }
  return procman.start(buildFpmSpec(version));
}

// Version argument kept for API compatibility; only one FPM child exists.
function stopPhpFpm(_version) {
  return procman.stop('php');
}

function stopAllPhpFpm() {
  return procman.stop('php');
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

  return versions.map((v) => {
    const fullVersion = getPhpVersion(v);
    const running = isPhpFpmRunning(v);
    return {
      version: v,
      fullVersion: fullVersion || v,
      active: v === activeVersion,
      running,
      socketPath: brew.getPhpFpmSocketPath(v),
    };
  });
}

// Non-blocking variant used by the get-php-versions IPC handler. Probes every
// version's full number and FPM state in parallel so opening the PHP page
// doesn't freeze the main thread.
async function getInstalledPhpVersionsWithDetailsAsync() {
  const prefix = brew.getBrewPrefix();
  const versions = brew.getInstalledPhpVersions();
  const [activeVersion, running, outdated] = await Promise.all([
    brew.getActivePhpVersionAsync(),
    isPhpFpmRunningAsync(),
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
      // isPhpFpmRunning isn't version-specific (matches any "php-fpm: master"),
      // so the single probe result applies to whichever version is active.
      running,
      outdated: outdated.has(formula),
      socketPath: brew.getPhpFpmSocketPath(v),
    };
  });
}

// Lists PHP versions WPHerd can install via Homebrew, each flagged with whether
// it's already installed. Any installed version not in the known list (e.g. a
// newer release from a tap) is appended so nothing installed is ever hidden.
function getInstallablePhpVersions() {
  const installed = new Set(brew.getInstalledPhpVersions());
  const versions = [...new Set([...KNOWN_PHP_VERSIONS, ...installed])];
  return versions
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((version) => ({ version, installed: installed.has(version) }));
}

// Runs `brew <args...>`, streaming each output line to `onProgress`. Resolves on
// success; rejects with the tail of brew's output on failure. No sudo needed —
// brew writes into the Homebrew prefix.
function runBrewStreaming(args, onProgress) {
  return new Promise((resolve, reject) => {
    const brewBin = brew.getBrewPath();
    if (!brewBin) {
      reject(new Error('Homebrew is not installed'));
      return;
    }

    const prefix = brew.getBrewPrefix();
    const child = spawn(brewBin, args, {
      env: {
        ...process.env,
        PATH: `${prefix}/bin:${process.env.PATH}`,
        // Skip the slow auto-update on every run; keeps output focused.
        HOMEBREW_NO_AUTO_UPDATE: '1',
        HOMEBREW_NO_ENV_HINTS: '1',
      },
    });

    // brew writes most progress to stderr; keep a rolling tail for the error.
    let tail = '';
    const emit = (buf) => {
      const text = buf.toString();
      tail = (tail + text).slice(-4000);
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && typeof onProgress === 'function') onProgress(trimmed);
      }
    };

    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(tail.trim() || `brew ${args.join(' ')} failed (exit ${code})`)
        );
      }
    });
  });
}

// Installs a PHP version via Homebrew (core or the shivammathur/php tap).
function installPhpVersion(version, onProgress) {
  if (!/^\d+\.\d+$/.test(String(version))) {
    return Promise.reject(new Error('Invalid PHP version'));
  }
  return runBrewStreaming(['install', installFormulaFor(version)], onProgress);
}

// Upgrades an installed PHP version to its latest patch release.
function updatePhpVersion(version, onProgress) {
  if (!/^\d+\.\d+$/.test(String(version))) {
    return Promise.reject(new Error('Invalid PHP version'));
  }
  const formula = brew.phpFormulaForVersion(version);
  if (!formula) {
    return Promise.reject(new Error(`PHP ${version} is not installed`));
  }
  return runBrewStreaming(['upgrade', formula], onProgress);
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
// user's php.ini; instead we write a WPHerd-managed override into that version's
// conf.d directory (loaded last, so it wins). Each setting stores a single plain
// number that maps to one or more directives.
const PHP_INI_SETTINGS = [
  {
    key: 'upload_max_filesize',
    label: 'Max File Upload Size',
    unit: 'MB',
    description:
      'Maximum file size that PHP will accept as file uploads (in MB).',
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
// global php.ini and the WPHerd-managed conf.d file — for this site only.
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
    description:
      'Maximum time in seconds that a script is allowed to parse input data.',
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
  return `${prefix}/etc/php/${version}/conf.d/zz-wpherd.ini`;
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

// Reads the WPHerd-managed values for a version, falling back to defaults for
// any setting that hasn't been customised yet. Values are round-tripped via a
// `; wpherd:<key>=<number>` comment so the plain number survives directive
// formatting (e.g. "128M").
function readManagedValues(version) {
  const values = {};
  for (const s of PHP_INI_SETTINGS) values[s.key] = s.default;

  const p = getManagedIniPath(version);
  try {
    if (p && fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf8');
      for (const s of PHP_INI_SETTINGS) {
        const m = content.match(new RegExp(`^; wpherd:${s.key}=(-?\\d+)`, 'm'));
        if (m) values[s.key] = parseInt(m[1], 10);
      }
    }
  } catch {}
  return values;
}

function writeManagedIni(version, values) {
  const p = getManagedIniPath(version);
  if (!p) throw new Error('Could not resolve the PHP config directory.');
  const dir = p.slice(0, p.lastIndexOf('/'));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const lines = ['; Managed by WPHerd — edit these from the app.', ''];
  for (const s of PHP_INI_SETTINGS) {
    const v = values[s.key];
    lines.push(`; wpherd:${s.key}=${v}`);
    for (const [directive, val] of Object.entries(s.toDirectives(v))) {
      lines.push(`${directive} = ${val}`);
    }
    lines.push('');
  }
  fs.writeFileSync(p, lines.join('\n'), 'utf8');
}

// Reloads the supervised FPM child only if it's currently running *this*
// version, so a config change takes effect without spuriously starting a
// stopped service. SIGUSR2 is php-fpm's graceful reload: workers respawn and
// re-read php.ini/conf.d with zero dropped requests.
function reloadPhpFpmIfRunning(version) {
  try {
    if (getRunningFpmVersion() === version && procman.isSupervised('php')) {
      procman.signal('php', 'SIGUSR2');
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
  getRunningFpmVersion,
  getInstalledPhpVersionsWithDetails,
  getInstalledPhpVersionsWithDetailsAsync,
  getInstallablePhpVersions,
  installPhpVersion,
  updatePhpVersion,
  switchActivePhpVersion,
  getBrewServiceName,
  getPhpIniSettings,
  reloadPhpFpmIfRunning,
  setPhpIniSetting,
  setPhpIniSettingAllVersions,
  getSitePhpSettingsSchema,
  getGlobalSitePhpValues,
  validateSitePhpSettings,
  buildSitePhpValue,
};
