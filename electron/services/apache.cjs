'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const brew = require('./brew.cjs');
const phpService = require('./php.cjs');
const execAsync = require('./asyncExec.cjs');
const procman = require('./procman.cjs');

// Apache (httpd) support for per-site webserver choice (Tier 2 #8, Option B).
//
// nginx stays the front door on :80/:443; Apache runs as a supervised child on
// an internal loopback port and serves only the sites flagged `webserver:
// 'apache'`, which nginx reverse-proxies to it. Apache hands .php to the same
// php-fpm pool nginx uses, via mod_proxy_fcgi. TLS terminates at nginx, so
// Apache only ever listens plain HTTP internally.
//
// Known limitation: per-site PHP overrides (php.buildSitePhpValue) ride nginx's
// `fastcgi_param PHP_VALUE`; over mod_proxy_fcgi that channel isn't available,
// so an Apache-flagged site falls back to its PHP version's global managed ini.
// True per-site overrides under Apache would need per-site FPM pools — a
// follow-up, not built here.

// Internal HTTP port nginx proxies Apache-flagged sites to. Loopback only.
const APACHE_HTTP_PORT = 8080;

function getApacheConfDir() {
  const prefix = brew.getBrewPrefix();
  if (!prefix) return null;
  return `${prefix}/etc/httpd`;
}

// WPHerd owns a self-contained httpd.conf (never the user's) plus a servers dir
// for the generated per-site vhosts.
function getGeneratedConfPath() {
  const dir = getApacheConfDir();
  return dir ? path.join(dir, 'wpherd-httpd.conf') : null;
}

function getServersDir() {
  const dir = getApacheConfDir();
  return dir ? path.join(dir, 'wpherd-servers') : null;
}

function getApacheLogDir() {
  const prefix = brew.getBrewPrefix();
  if (!prefix) return '/tmp';
  const logDir = `${prefix}/var/log/httpd`;
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  return logDir;
}

function getHttpdBinPath() {
  const prefix = brew.getBrewPrefix();
  if (!prefix) return null;
  const optPath = `${prefix}/opt/httpd/bin/httpd`;
  if (fs.existsSync(optPath)) return optPath;
  const linkedPath = `${prefix}/bin/httpd`;
  if (fs.existsSync(linkedPath)) return linkedPath;
  return null;
}

function isInstalled() {
  return getHttpdBinPath() !== null;
}

function installApache(onProgress) {
  return phpService.runBrewStreaming(['install', 'httpd'], onProgress);
}

// Only match the httpd master WPHerd manages (our generated conf on its command
// line), never an unrelated system httpd.
function isRunning() {
  try {
    execSync(`pgrep -f wpherd-httpd.conf`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function isRunningAsync() {
  try {
    await execAsync(`pgrep -f wpherd-httpd.conf`, { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

// ─── Config generation (pure-ish; covered by vitest) ─────────────────────────

// Emits a LoadModule line only for modules that ship as a shared object in this
// httpd build — anything compiled static is already available, and pointing
// LoadModule at a missing .so is a fatal httpd config error.
function loadModuleLines(modulesDir) {
  const wanted = [
    ['mpm_event_module', 'mod_mpm_event.so'],
    ['unixd_module', 'mod_unixd.so'],
    ['authz_core_module', 'mod_authz_core.so'],
    ['log_config_module', 'mod_log_config.so'],
    ['mime_module', 'mod_mime.so'],
    ['dir_module', 'mod_dir.so'],
    ['env_module', 'mod_env.so'],
    ['setenvif_module', 'mod_setenvif.so'],
    ['headers_module', 'mod_headers.so'],
    ['proxy_module', 'mod_proxy.so'],
    ['proxy_fcgi_module', 'mod_proxy_fcgi.so'],
    ['rewrite_module', 'mod_rewrite.so'],
  ];
  const lines = [];
  for (const [directive, file] of wanted) {
    // When we can't stat the modules dir (tests, odd layouts) emit all lines —
    // httpd validates at start and the error surfaces there.
    let exists = true;
    try {
      exists = !modulesDir || fs.existsSync(path.join(modulesDir, file));
    } catch {
      exists = true;
    }
    if (exists) lines.push(`LoadModule ${directive} lib/httpd/modules/${file}`);
  }
  return lines.join('\n');
}

// The self-contained httpd.conf. Runs as the invoking (non-root) user, so no
// User/Group directives. Serves nothing itself except the included vhosts.
function generateHttpdConf(prefix) {
  // All paths derive from the passed prefix so this stays a pure function of
  // its argument (dir creation happens in ensureConfig, not here).
  const modulesDir = prefix ? path.join(prefix, 'lib', 'httpd', 'modules') : null;
  const logDir = `${prefix}/var/log/httpd`;
  const serversDir = `${prefix}/etc/httpd/wpherd-servers`;
  const pidFile = `${prefix}/var/run/wpherd-httpd.pid`;
  const mimeTypes = `${prefix}/etc/httpd/mime.types`;
  const hasMime = (() => {
    try {
      return fs.existsSync(mimeTypes);
    } catch {
      return false;
    }
  })();

  return `# Managed by WPHerd — do not edit. Regenerated on start.
ServerRoot "${prefix}"
PidFile "${pidFile}"
Listen 127.0.0.1:${APACHE_HTTP_PORT}
ServerName localhost

${loadModuleLines(modulesDir)}

ServerAdmin wpherd@localhost
${hasMime ? `TypesConfig "${mimeTypes}"` : ''}
DefaultType text/plain

ErrorLog "${logDir}/apache.error.log"
<IfModule log_config_module>
    LogFormat "%h %l %u %t \\"%r\\" %>s %b" common
    CustomLog "${logDir}/apache.access.log" common
</IfModule>

<Directory />
    AllowOverride None
    Require all denied
</Directory>

DirectoryIndex index.php index.html index.htm

IncludeOptional "${serversDir}/*.conf"
`;
}

// Per-site Apache vhost. Mirrors nginx.generateSiteConfig: same root, index,
// upload limit, and a WordPress front-controller fallback; .php is handed to
// php-fpm over mod_proxy_fcgi. `is_ssl()` is restored from nginx's
// X-Forwarded-Proto so https sites don't redirect-loop behind the proxy.
function generateApacheVhost(site) {
  const { name, domain, path: sitePath, phpVersion } = site;
  const aliases = Array.isArray(site.aliases) ? site.aliases : [];

  if (!/^[a-z0-9.-]+$/.test(domain)) {
    throw new Error(`Unsafe domain for Apache config: ${domain}`);
  }
  for (const alias of aliases) {
    if (!/^[a-z0-9.-]+$/.test(alias)) {
      throw new Error(`Unsafe server-name alias for Apache config: ${alias}`);
    }
  }
  if (/[\n\r\0"]/.test(sitePath)) {
    throw new Error(`Unsafe site path for Apache config: ${sitePath}`);
  }

  // Same php-fpm target nginx uses: a per-version unix socket when present,
  // else the shared TCP pool. mod_proxy_fcgi's SetHandler syntax.
  let fcgiTarget = `fcgi://127.0.0.1:9000`;
  try {
    const sock = brew.getPhpFpmSocketPath(phpVersion);
    if (sock && fs.existsSync(sock)) fcgiTarget = `unix:${sock}|fcgi://localhost`;
  } catch {}

  // Effective upload limit → LimitRequestBody (bytes), matching nginx's
  // client_max_body_size sizing.
  let uploadMB = 100;
  try {
    if (site.phpSettings && Number.isInteger(site.phpSettings.upload_max_filesize)) {
      uploadMB = site.phpSettings.upload_max_filesize;
    } else {
      uploadMB = phpService.getGlobalSitePhpValues(phpVersion).upload_max_filesize;
    }
  } catch {}
  if (!Number.isInteger(uploadMB) || uploadMB < 1) uploadMB = 100;
  const bodyLimitBytes = Math.max(8, Math.ceil(uploadMB * 1.1)) * 1024 * 1024;

  const logDir = getApacheLogDir();
  const serverAlias = aliases.length ? `\n    ServerAlias ${aliases.join(' ')}` : '';

  return `# WPHerd: ${name}
<VirtualHost 127.0.0.1:${APACHE_HTTP_PORT}>
    ServerName ${domain}${serverAlias}
    DocumentRoot "${sitePath}"

    LimitRequestBody ${bodyLimitBytes}

    # nginx terminates TLS and forwards the scheme; restore HTTPS for is_ssl().
    <IfModule setenvif_module>
        SetEnvIf X-Forwarded-Proto https HTTPS=on
    </IfModule>

    <Directory "${sitePath}">
        AllowOverride All
        Require all granted
        DirectoryIndex index.php index.html index.htm
        FallbackResource /index.php
    </Directory>

    <FilesMatch \\.php$>
        SetHandler "proxy:${fcgiTarget}"
    </FilesMatch>

    ErrorLog "${logDir}/${domain}.error.log"
    CustomLog "${logDir}/${domain}.access.log" common
</VirtualHost>
`;
}

// ─── Filesystem / lifecycle ─────────────────────────────────────────────────

function ensureConfig() {
  const dir = getApacheConfDir();
  if (!dir) throw new Error('Could not resolve the Apache config directory.');
  const serversDir = getServersDir();
  if (!fs.existsSync(serversDir)) fs.mkdirSync(serversDir, { recursive: true });
  getApacheLogDir();
  const confPath = getGeneratedConfPath();
  fs.writeFileSync(confPath, generateHttpdConf(brew.getBrewPrefix()), 'utf8');
}

function createSiteVhost(site) {
  ensureConfig();
  const serversDir = getServersDir();
  const configPath = path.join(serversDir, `${site.domain}.conf`);
  fs.writeFileSync(configPath, generateApacheVhost(site), 'utf8');
  return configPath;
}

function removeSiteVhost(domain) {
  const serversDir = getServersDir();
  if (!serversDir) return;
  const configPath = path.join(serversDir, `${domain}.conf`);
  if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
}

function siteVhostExists(domain) {
  const serversDir = getServersDir();
  if (!serversDir) return false;
  return fs.existsSync(path.join(serversDir, `${domain}.conf`));
}

// Delete stray root-owned artifacts from a prior run so our unprivileged child
// can open its logs/pid (mirrors nginx.removeForeignArtifacts).
function removeForeignArtifacts() {
  const prefix = brew.getBrewPrefix();
  if (!prefix) return;
  const uid = process.getuid ? process.getuid() : null;
  if (uid == null) return;
  const sweep = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const nm of entries) {
      const p = path.join(dir, nm);
      try {
        if (fs.lstatSync(p).uid !== uid) fs.rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  };
  sweep(`${prefix}/var/log/httpd`);
  try {
    const pidFile = `${prefix}/var/run/wpherd-httpd.pid`;
    if (fs.existsSync(pidFile) && fs.lstatSync(pidFile).uid !== uid) {
      fs.rmSync(pidFile, { force: true });
    }
  } catch {}
}

function validateConfig() {
  try {
    execSync(`${getHttpdBinPath()} -t -f ${getGeneratedConfPath()}`, { stdio: 'pipe' });
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.stderr?.toString() || err.message };
  }
}

function buildSpec() {
  const bin = getHttpdBinPath();
  if (!bin) throw new Error('Apache (httpd) is not installed.');
  const prefix = brew.getBrewPrefix();
  return {
    name: 'apache',
    bin,
    args: ['-D', 'FOREGROUND', '-f', getGeneratedConfPath()],
    cwd: prefix,
    stopSignal: 'SIGTERM',
    stopTimeoutMs: 10_000,
    conflictProbe: isRunningAsync,
  };
}

async function start() {
  if (!isInstalled()) throw new Error('Apache (httpd) is not installed.');
  ensureConfig();
  removeForeignArtifacts();
  const { valid, error } = validateConfig();
  if (!valid) throw new Error(`Apache config test failed: ${error}`);
  return procman.start(buildSpec());
}

function stop() {
  return procman.stop('apache');
}

async function restart() {
  ensureConfig();
  const { valid, error } = validateConfig();
  if (!valid) throw new Error(`Apache config test failed: ${error}`);
  return procman.restart(buildSpec());
}

// Graceful reload (httpd SIGUSR1: workers finish in-flight requests).
function reload() {
  if (procman.isSupervised('apache')) {
    try {
      procman.signal('apache', 'SIGUSR1');
      return;
    } catch {}
  }
  try {
    execSync(`${getHttpdBinPath()} -f ${getGeneratedConfPath()} -k graceful`, {
      stdio: 'pipe',
    });
  } catch {
    start().catch(() => {});
  }
}

module.exports = {
  APACHE_HTTP_PORT,
  getApacheConfDir,
  getServersDir,
  getGeneratedConfPath,
  getHttpdBinPath,
  isInstalled,
  installApache,
  isRunning,
  isRunningAsync,
  loadModuleLines,
  generateHttpdConf,
  generateApacheVhost,
  ensureConfig,
  createSiteVhost,
  removeSiteVhost,
  siteVhostExists,
  validateConfig,
  start,
  stop,
  restart,
  reload,
};
