'use strict';

const { execSync, execFileSync, spawn } = require('child_process');
const fs = require('fs');
const brew = require('./brew.cjs');
const execAsync = require('./asyncExec.cjs');

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

function startPhpFpm(version) {
  const serviceName = getBrewServiceName(version);
  brew.startBrewService(serviceName);
}

function stopPhpFpm(version) {
  const serviceName = getBrewServiceName(version);
  brew.stopBrewService(serviceName);
}

function stopAllPhpFpm() {
  const versions = brew.getInstalledPhpVersions();
  for (const v of versions) {
    try {
      const serviceName = getBrewServiceName(v);
      brew.stopBrewService(serviceName);
    } catch {}
  }
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

// Restarts a version's PHP-FPM only if it's currently running, so a config
// change takes effect without spuriously starting a stopped service.
function reloadPhpFpmIfRunning(version) {
  try {
    const svc = getBrewServiceName(version);
    if (brew.getBrewServiceStatus(svc) === 'running') {
      brew.restartBrewService(svc);
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
  getInstalledPhpVersionsWithDetails,
  getInstalledPhpVersionsWithDetailsAsync,
  getInstallablePhpVersions,
  installPhpVersion,
  updatePhpVersion,
  switchActivePhpVersion,
  getBrewServiceName,
  getPhpIniSettings,
  setPhpIniSetting,
  setPhpIniSettingAllVersions,
};
