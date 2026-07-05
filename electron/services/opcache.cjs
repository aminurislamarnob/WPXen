'use strict';

const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const http = require('http');
const https = require('https');
const brew = require('./brew.cjs');
const php = require('./php.cjs');

const execFileAsync = promisify(execFile);

// OpCache management. OpCache ships as a Zend extension bundled with every
// Homebrew PHP (loaded by brew's own `ext-opcache.ini`) — we never touch that
// loader. Instead, mirroring the php.ini and Xdebug patterns, we own a separate
// conf.d file that sorts AFTER it (zz-wpherd-opcache.ini) and only sets
// `opcache.*` directives. Disabling OpCache is `opcache.enable = 0`: the
// extension stays loaded but inert, so we never unlink the loader file.
//
// Config knobs are pure ini writes (see php.cjs's managed-ini pattern). Live
// runtime stats (hit rate, memory, cached scripts) are only meaningful inside
// the running php-fpm SAPI — the CLI has its own/disabled cache — so they come
// from an ephemeral probe served by a running site's FPM pool (see
// getOpcacheLiveStats).

// Editable OpCache directives. `bool` values round-trip as 0/1; `int` values as
// plain numbers. Each maps to one or more real `opcache.*` directives.
const OPCACHE_SETTINGS = [
  {
    key: 'enable',
    label: 'Enable OpCache',
    type: 'bool',
    default: true,
    description:
      'Compile and cache PHP bytecode in shared memory. Off leaves the extension loaded but inert.',
    toDirectives: (v) => ({ 'opcache.enable': v ? 1 : 0, 'opcache.enable_cli': v ? 1 : 0 }),
  },
  {
    key: 'memory_consumption',
    label: 'Memory',
    type: 'int',
    unit: 'MB',
    default: 128,
    min: 8,
    max: 4096,
    description: 'Shared memory (MB) OpCache may use to store compiled bytecode.',
    toDirectives: (v) => ({ 'opcache.memory_consumption': v }),
  },
  {
    key: 'max_accelerated_files',
    label: 'Max Cached Files',
    type: 'int',
    unit: null,
    default: 10000,
    min: 200,
    max: 1000000,
    description: 'Upper bound on the number of scripts held in the cache.',
    toDirectives: (v) => ({ 'opcache.max_accelerated_files': v }),
  },
  {
    key: 'revalidate_freq',
    label: 'Revalidate Frequency',
    type: 'int',
    unit: 'sec',
    default: 2,
    min: 0,
    max: 3600,
    description:
      'How often (seconds) OpCache checks a cached file for changes. Ignored when timestamp validation is off.',
    toDirectives: (v) => ({ 'opcache.revalidate_freq': v }),
  },
  {
    key: 'validate_timestamps',
    label: 'Validate Timestamps',
    type: 'bool',
    default: true,
    description:
      'When off, PHP never re-checks files for changes (production-like, fastest) — you must reset OpCache manually after edits.',
    toDirectives: (v) => ({ 'opcache.validate_timestamps': v ? 1 : 0 }),
  },
];

// PHP served over a site's own FPM pool, emitting opcache_get_status() as JSON.
// Dropped into a running site's docroot, fetched over loopback, then deleted.
const PROBE_PHP = `<?php
header('Content-Type: application/json');
if (!function_exists('opcache_get_status')) { echo json_encode(array('enabled' => false)); exit; }
$s = @opcache_get_status(false);
if ($s === false) { echo json_encode(array('enabled' => false)); exit; }
$m = isset($s['memory_usage']) ? $s['memory_usage'] : array();
$st = isset($s['opcache_statistics']) ? $s['opcache_statistics'] : array();
echo json_encode(array(
  'enabled' => !empty($s['opcache_enabled']),
  'used_memory' => isset($m['used_memory']) ? $m['used_memory'] : null,
  'free_memory' => isset($m['free_memory']) ? $m['free_memory'] : null,
  'wasted_memory' => isset($m['wasted_memory']) ? $m['wasted_memory'] : null,
  'cached_scripts' => isset($st['num_cached_scripts']) ? $st['num_cached_scripts'] : null,
  'hits' => isset($st['hits']) ? $st['hits'] : null,
  'misses' => isset($st['misses']) ? $st['misses'] : null,
  'hit_rate' => isset($st['opcache_hit_rate']) ? $st['opcache_hit_rate'] : null,
));
`;

// ─── Pure helpers (covered by vitest) ───────────────────────────────────────

// Renders the managed ini for a value map. Values survive directive formatting
// via `; wpherd:<key>=<0|1|int>` markers. Pure.
function renderOpcacheIni(values = {}) {
  const lines = ['; Managed by WPHerd — edit OpCache from the app.', ''];
  for (const s of OPCACHE_SETTINGS) {
    const v = values[s.key] == null ? s.default : values[s.key];
    const marker = s.type === 'bool' ? (v ? 1 : 0) : v;
    lines.push(`; wpherd:${s.key}=${marker}`);
    for (const [directive, val] of Object.entries(s.toDirectives(v))) {
      lines.push(`${directive} = ${val}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// Reads a value map back out of a managed ini's markers, defaulting anything
// missing. Pure.
function parseOpcacheIni(content) {
  const values = {};
  for (const s of OPCACHE_SETTINGS) values[s.key] = s.default;
  const text = String(content || '');
  for (const s of OPCACHE_SETTINGS) {
    const m = text.match(new RegExp(`^; wpherd:${s.key}=(-?\\d+)`, 'm'));
    if (m) {
      const n = parseInt(m[1], 10);
      values[s.key] = s.type === 'bool' ? n === 1 : n;
    }
  }
  return values;
}

// Validates a raw input against a setting's type/range, returning a bool or a
// clamped-range integer. Throws on non-numeric or out-of-range values. Pure.
function validateOpcacheValue(setting, value) {
  if (setting.type === 'bool') {
    if (value === true || value === false) return value;
    if (value === 1 || value === '1' || value === 'true') return true;
    if (value === 0 || value === '0' || value === 'false') return false;
    throw new Error(`${setting.label} must be on or off.`);
  }
  const num = parseInt(value, 10);
  if (Number.isNaN(num) || String(value).trim() === '') {
    throw new Error(`${setting.label} must be a number.`);
  }
  if (setting.min != null && num < setting.min) {
    throw new Error(`${setting.label} must be at least ${setting.min}.`);
  }
  if (setting.max != null && num > setting.max) {
    throw new Error(`${setting.label} must be at most ${setting.max}.`);
  }
  return num;
}

// Normalizes the probe's JSON into the shape the renderer displays. Pure.
function parseLiveStats(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  if (!obj.enabled) return { enabled: false };

  const toNum = (x) => (x == null || Number.isNaN(Number(x)) ? null : Number(x));
  const used = toNum(obj.used_memory);
  const free = toNum(obj.free_memory);
  const wasted = toNum(obj.wasted_memory);
  const total = used != null && free != null && wasted != null ? used + free + wasted : null;
  const bytesToMB = (b) => (b == null ? null : Math.round((b / 1048576) * 10) / 10);
  const hitRate = toNum(obj.hit_rate);

  return {
    enabled: true,
    usedMB: bytesToMB(used),
    totalMB: bytesToMB(total),
    cachedScripts: toNum(obj.cached_scripts),
    hits: toNum(obj.hits),
    misses: toNum(obj.misses),
    hitRate: hitRate == null ? null : Math.round(hitRate * 10) / 10,
  };
}

// Metadata for the renderer (no functions).
function getSettingsMeta() {
  return OPCACHE_SETTINGS.map(({ key, label, type, unit, default: def, min, max, description }) => ({
    key,
    label,
    type,
    unit: unit ?? null,
    default: def,
    min: min ?? null,
    max: max ?? null,
    description,
  }));
}

// ─── Filesystem / process-backed ────────────────────────────────────────────

function getOpcacheIniPath(version) {
  const prefix = brew.getBrewPrefix();
  if (!prefix) return null;
  return `${prefix}/etc/php/${version}/conf.d/zz-wpherd-opcache.ini`;
}

function readOpcacheValues(version) {
  const p = getOpcacheIniPath(version);
  try {
    if (p && fs.existsSync(p)) return parseOpcacheIni(fs.readFileSync(p, 'utf8'));
  } catch {}
  const values = {};
  for (const s of OPCACHE_SETTINGS) values[s.key] = s.default;
  return values;
}

function writeOpcacheIni(version, values) {
  const p = getOpcacheIniPath(version);
  if (!p) throw new Error('Could not resolve the PHP config directory.');
  const dir = p.slice(0, p.lastIndexOf('/'));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, renderOpcacheIni(values), 'utf8');
}

// Whether the OpCache extension is actually loaded by this version's PHP.
function isOpcacheAvailable(version) {
  const phpBin = php.getPhpBinPath(version);
  if (!phpBin) return false;
  try {
    const out = execFileSync(phpBin, ['-m'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    return /^Zend OPcache$/im.test(out);
  } catch {
    return false;
  }
}

// Non-blocking variant: getOpcacheConfig runs one of these per installed version
// on every PHP page load, so keep the `php -m` spawns off the main thread.
async function isOpcacheAvailableAsync(version) {
  const phpBin = php.getPhpBinPath(version);
  if (!phpBin) return false;
  try {
    const { stdout } = await execFileAsync(phpBin, ['-m'], { timeout: 4000 });
    return /^Zend OPcache$/im.test(stdout);
  } catch {
    return false;
  }
}

// Config + availability for one version.
async function getOpcacheState(version) {
  return {
    version,
    available: await isOpcacheAvailableAsync(version),
    values: readOpcacheValues(version),
  };
}

// Aggregate config for every installed version, plus schema metadata and the
// version FPM is currently running (the only one live stats can be read from).
// The per-version availability probes run in parallel, off the main thread.
async function getOpcacheConfig() {
  return {
    settings: getSettingsMeta(),
    runningVersion: php.getRunningFpmVersion(),
    versions: await Promise.all(brew.getInstalledPhpVersions().map((v) => getOpcacheState(v))),
  };
}

function assertVersion(version) {
  if (!/^\d+\.\d+$/.test(String(version))) throw new Error('Invalid PHP version');
  if (!brew.getInstalledPhpVersions().includes(version)) {
    throw new Error(`PHP ${version} is not installed`);
  }
}

// Writes a single setting for one version and hot-reloads FPM if it's running
// this version (SIGUSR2 — see php.reloadPhpFpmIfRunning).
function setOpcache(version, key, value) {
  assertVersion(version);
  const setting = OPCACHE_SETTINGS.find((s) => s.key === key);
  if (!setting) throw new Error(`Unknown OpCache setting: ${key}`);
  const clean = validateOpcacheValue(setting, value);
  const values = readOpcacheValues(version);
  values[key] = clean;
  writeOpcacheIni(version, values);
  php.reloadPhpFpmIfRunning(version);
  // Return the persisted values synchronously (no re-probe of availability —
  // the renderer re-fetches the full config after a save anyway).
  return { version, available: isOpcacheAvailable(version), values };
}

function setOpcacheAll(key, value) {
  for (const version of brew.getInstalledPhpVersions()) {
    setOpcache(version, key, value);
  }
}

// Fetches a loopback URL served by the site's own webserver/FPM. Follows a
// single http→https redirect (WPHerd's https sites redirect port 80). Uses the
// site domain as Host/SNI; accepts the self-signed cert.
function httpGetLoopback(site, pathname, redirects = 1) {
  return new Promise((resolve, reject) => {
    const useHttps = !!site.https;
    const mod = useHttps ? https : http;
    const opts = {
      host: '127.0.0.1',
      port: useHttps ? 443 : 80,
      path: pathname,
      method: 'GET',
      headers: { Host: site.domain },
      timeout: 5000,
    };
    if (useHttps) {
      opts.rejectUnauthorized = false;
      opts.servername = site.domain;
    }
    const req = mod.request(opts, (res) => {
      if (
        [301, 302, 307, 308].includes(res.statusCode) &&
        redirects > 0 &&
        res.headers.location
      ) {
        res.resume();
        resolve(httpGetLoopback({ ...site, https: true }, pathname, redirects - 1));
        return;
      }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('Probe timed out')));
    req.on('error', reject);
    req.end();
  });
}

// Live OpCache stats for a version, read from a running site's FPM pool. The
// caller passes the site list (the store lives in ipc.cjs). Returns
// {available:false, reason} when there's nothing to probe.
async function getOpcacheLiveStats(version, sites = []) {
  if (php.getRunningFpmVersion() !== version) {
    return { available: false, reason: 'fpm-not-running' };
  }
  // Any site with a real docroot works: every WPHerd site executes on the
  // single running FPM pool (all listen on 127.0.0.1:9000), so the probe
  // reflects `version` regardless of a site's own pinned phpVersion.
  const site = (sites || []).find((s) => s.path && fs.existsSync(s.path));
  if (!site) return { available: false, reason: 'no-site' };

  const probeName = `wpherd-opcache-probe-${Date.now()}.php`;
  const probePath = `${site.path.replace(/\/$/, '')}/${probeName}`;
  try {
    fs.writeFileSync(probePath, PROBE_PHP, 'utf8');
    const raw = await httpGetLoopback(site, `/${probeName}`);
    const stats = parseLiveStats(raw);
    if (!stats) return { available: false, reason: 'parse-error' };
    return { available: true, ...stats };
  } catch {
    return { available: false, reason: 'probe-failed' };
  } finally {
    try {
      fs.unlinkSync(probePath);
    } catch {}
  }
}

module.exports = {
  OPCACHE_SETTINGS,
  renderOpcacheIni,
  parseOpcacheIni,
  validateOpcacheValue,
  parseLiveStats,
  getSettingsMeta,
  getOpcacheIniPath,
  readOpcacheValues,
  writeOpcacheIni,
  isOpcacheAvailable,
  isOpcacheAvailableAsync,
  getOpcacheState,
  getOpcacheConfig,
  setOpcache,
  setOpcacheAll,
  getOpcacheLiveStats,
};
