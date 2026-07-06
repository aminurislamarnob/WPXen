'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const brew = require('./brew.cjs');
const phpService = require('./php.cjs');
const execAsync = require('./asyncExec.cjs');
const procman = require('./procman.cjs');

function getNginxConfDir() {
  const prefix = brew.getBrewPrefix();
  if (!prefix) return null;
  return `${prefix}/etc/nginx`;
}

function getServersDir() {
  const confDir = getNginxConfDir();
  return confDir ? path.join(confDir, 'servers') : null;
}

function getNginxLogDir() {
  const prefix = brew.getBrewPrefix();
  if (!prefix) return '/tmp';
  const logDir = `${prefix}/var/log/nginx`;
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  return logDir;
}

function isRunning() {
  try {
    // `pgrep -x nginx` only matches when started by bare name; launchd /
    // `brew services` launch nginx via absolute path, so fall back to a
    // full-args match on the binary path or its rewritten master title.
    execSync("pgrep -x nginx || pgrep -f '[/ ]nginx'", { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Non-blocking variant used by the status poller (see asyncExec.cjs).
async function isRunningAsync() {
  try {
    await execAsync("pgrep -x nginx || pgrep -f '[/ ]nginx'", { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

function getNginxBinPath() {
  const prefix = brew.getBrewPrefix();
  if (!prefix) return null;
  const optPath = `${prefix}/opt/nginx/bin/nginx`;
  if (fs.existsSync(optPath)) return optPath;
  const linkedPath = `${prefix}/bin/nginx`;
  if (fs.existsSync(linkedPath)) return linkedPath;
  return null;
}

// nginx runs as a supervised child of WPHerd (see procman.cjs). No root
// needed: since macOS 10.14 unprivileged processes may bind ports below 1024,
// so 80/443 work from a plain child process (this is how Herd does it too).
function buildSpec() {
  const bin = getNginxBinPath();
  if (!bin) throw new Error('nginx is not installed.');
  const prefix = brew.getBrewPrefix();
  return {
    name: 'nginx',
    bin,
    // launchd/brew runs the same invocation: stay in the foreground so the
    // supervisor owns the master process (nginx self-daemonizes by default).
    args: ['-g', 'daemon off;'],
    cwd: prefix,
    stopSignal: 'SIGQUIT', // graceful: workers finish in-flight requests
    stopTimeoutMs: 10_000,
    // A SIGKILLed master leaves its workers orphaned (reparented to launchd),
    // still holding :80/:443 — sweep them before every (re)spawn and after a
    // forced kill of our own child.
    preSpawn: async () => {
      try {
        await execAsync(
          `ps -axo pid=,ppid=,command= | awk '$2==1 && $0 ~ /nginx: worker process/ {print $1}' | xargs kill -9`,
          { timeout: 4000 }
        );
      } catch {}
    },
    onForceKilled: async () => {
      try {
        await execAsync("pkill -f 'nginx: worker process'", { timeout: 4000 });
      } catch {}
    },
    // A pre-migration launchd instance (root daemon) can't be cleared without
    // sudo; the takeover uses the sudo path (silent when sudoers installed).
    conflictProbe: isRunningAsync,
    takeover: async () => {
      try {
        brew.stopBrewServiceSudo('nginx');
      } catch {}
      try {
        brew.stopBrewService('nginx');
      } catch {}
    },
  };
}

// The pre-migration nginx ran as a root LaunchDaemon, leaving root-owned log
// files and nobody-owned worker temp dirs behind. Our unprivileged child can't
// open those, so `nginx -t` fails with EACCES. The parent dirs are user-owned
// (Homebrew keeps its prefix user-owned), so we can simply delete anything not
// ours — nginx recreates it on start with the right owner.
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
    for (const name of entries) {
      const p = path.join(dir, name);
      try {
        if (fs.lstatSync(p).uid !== uid) {
          fs.rmSync(p, { recursive: true, force: true });
        }
      } catch {}
    }
  };

  sweep(`${prefix}/var/log/nginx`);
  sweep(`${prefix}/var/run/nginx`);
  try {
    const pidFile = `${prefix}/var/run/nginx.pid`;
    if (fs.existsSync(pidFile) && fs.lstatSync(pidFile).uid !== uid) {
      fs.rmSync(pidFile, { force: true });
    }
  } catch {}
}

async function start() {
  removeForeignArtifacts();
  // Pre-flight the config so a typo yields "nginx -t" output instead of a
  // silent crash loop.
  const { valid, error } = validateConfig();
  if (!valid) {
    throw new Error(`nginx config test failed: ${error}`);
  }
  return procman.start(buildSpec());
}

function stop() {
  return procman.stop('nginx');
}

async function restart() {
  const { valid, error } = validateConfig();
  if (!valid) {
    throw new Error(`nginx config test failed: ${error}`);
  }
  return procman.restart(buildSpec());
}

function reload() {
  // Prefer signaling our own supervised master; fall back to the pid-file
  // based `nginx -s reload` for an instance we didn't spawn.
  if (procman.isSupervised('nginx')) {
    try {
      procman.signal('nginx', 'SIGHUP');
      return;
    } catch {}
  }
  try {
    execSync(`${getNginxBinPath()} -s reload`, { stdio: 'pipe' });
  } catch {
    // No reachable master — bring nginx up instead (matches the old
    // reload-falls-back-to-restart behavior callers rely on during site
    // creation). Fire-and-forget: callers treat reload as best-effort.
    start().catch(() => {});
  }
}

function ensureServersDir() {
  const dir = getServersDir();
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Ensure servers directory is included in nginx.conf
  const confDir = getNginxConfDir();
  if (!confDir) return;
  const confFile = path.join(confDir, 'nginx.conf');
  if (fs.existsSync(confFile)) {
    const content = fs.readFileSync(confFile, 'utf8');
    if (!content.includes('servers/')) {
      // Inject include directive before the last closing brace
      const updated = content.replace(/(\s*}\s*)$/, '\n    include servers/*;\n$1');
      fs.writeFileSync(confFile, updated, 'utf8');
    }
  }
}

function generateSiteConfig(site) {
  const { name, domain, path: sitePath, phpVersion, https, certPath, keyPath } = site;

  // Extra hostnames the vhost should also answer to (e.g. a transient
  // *.trycloudflare.com share host). Each is validated like the primary domain.
  const aliases = Array.isArray(site.aliases) ? site.aliases : [];

  // Guard the values interpolated into the nginx config. A domain or path
  // containing a newline or `;`/`{`/`}` could otherwise inject arbitrary nginx
  // directives. Callers validate too, but this is the last line of defense.
  if (!/^[a-z0-9.-]+$/.test(domain)) {
    throw new Error(`Unsafe domain for nginx config: ${domain}`);
  }
  for (const alias of aliases) {
    if (!/^[a-z0-9.-]+$/.test(alias)) {
      throw new Error(`Unsafe server-name alias for nginx config: ${alias}`);
    }
  }

  // Optional htpasswd file protecting the tunnel alias hosts (basic-auth on
  // shares). When set, the aliases move into their own server block carrying
  // auth_basic, so the local .test domain stays password-free.
  const shareAuthFile = site.shareAuthFile || null;
  if (shareAuthFile && /[\n\r\0;{}"]/.test(shareAuthFile)) {
    throw new Error('Unsafe htpasswd path for nginx config');
  }
  const splitAliases = !!(shareAuthFile && aliases.length);

  // Space-separated list for the `server_name` directive.
  const serverNames = splitAliases ? domain : [domain, ...aliases].join(' ');
  const aliasNames = aliases.join(' ');
  if (/[\n\r\0;{}]/.test(sitePath)) {
    throw new Error(`Unsafe site path for nginx config: ${sitePath}`);
  }

  const useHttps = !!(https && certPath && keyPath);
  if (useHttps && (/[\n\r\0;{}]/.test(certPath) || /[\n\r\0;{}]/.test(keyPath))) {
    throw new Error('Unsafe certificate path for nginx config');
  }

  // Homebrew's php-fpm listens on TCP 127.0.0.1:9000 by default and does not
  // create a unix socket. Use a per-version socket only when one actually
  // exists; otherwise fall back to the TCP address so PHP requests resolve.
  const socketPath = brew.getPhpFpmSocketPath(phpVersion);
  const fastcgiPass =
    socketPath && fs.existsSync(socketPath) ? `unix:${socketPath}` : '127.0.0.1:9000';
  const logDir = getNginxLogDir();

  // nginx rejects request bodies larger than client_max_body_size (default
  // 1M) with "413 Request Entity Too Large" before PHP ever sees them, which
  // breaks wp-admin plugin/theme uploads. Size it from the site's effective
  // upload limit (override or global), with headroom for multipart overhead.
  let uploadMB =
    site.phpSettings && Number.isInteger(site.phpSettings.upload_max_filesize)
      ? site.phpSettings.upload_max_filesize
      : phpService.getGlobalSitePhpValues(phpVersion).upload_max_filesize;
  if (!Number.isInteger(uploadMB) || uploadMB < 1) uploadMB = 100;
  const bodyLimitMB = Math.max(8, Math.ceil(uploadMB * 1.1));

  // Per-site PHP overrides, passed to FPM via PHP_VALUE (newline-separated
  // directives). buildSitePhpValue only emits validated `key=<int>[M]` lines;
  // the regex is a last line of defense against config injection.
  const phpValue = phpService.buildSitePhpValue(site.phpSettings);
  if (phpValue && !/^[a-z_]+=-?\d+M?(\n[a-z_]+=-?\d+M?)*$/.test(phpValue)) {
    throw new Error('Unsafe PHP settings for nginx config');
  }
  const phpValueParam = phpValue
    ? `\n        fastcgi_param PHP_VALUE "${phpValue}";`
    : '';

  // Shared per-site directives (root, logging, PHP handling) — reused by the
  // http and https server blocks so both behave identically.
  const body = `    root ${sitePath};

    client_max_body_size ${bodyLimitMB}m;

    index index.php index.html index.htm;

    access_log ${logDir}/${domain}.access.log;
    error_log  ${logDir}/${domain}.error.log;

    location / {
        try_files $uri $uri/ /index.php?$args;
    }

    location ~ \\.php$ {
        try_files $uri =404;
        fastcgi_split_path_info ^(.+\\.php)(/.+)$;
        fastcgi_pass ${fastcgiPass};
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        fastcgi_param HTTP_PROXY "";
        fastcgi_param HTTPS ${useHttps ? '"on"' : '""'};${phpValueParam}
        fastcgi_read_timeout 300;
        include fastcgi_params;
    }

    location ~* \\.(css|js|gif|ico|jpeg|jpg|png|svg|webp|woff|woff2|ttf|eot)$ {
        expires max;
        log_not_found off;
        access_log off;
    }

    location = /favicon.ico {
        log_not_found off;
        access_log off;
    }

    location = /robots.txt {
        allow all;
        log_not_found off;
        access_log off;
    }

    location ~ /\\.ht {
        deny all;
    }`;

  // Basic-auth directives prepended to the alias server block when a share is
  // password-protected. Never applied to the primary .test server block.
  const authDirectives = `    auth_basic "WPHerd Share";
    auth_basic_user_file ${shareAuthFile};

`;

  if (useHttps) {
    // Redirect plain http to https, and serve the site over TLS on 443. The
    // redirect block carries no content, so it can keep every hostname even
    // when the aliases are split out for basic-auth.
    const redirectNames = [domain, ...aliases].join(' ');
    const aliasBlock = splitAliases
      ? `
server {
    listen 443 ssl;
    server_name ${aliasNames};

    ssl_certificate ${certPath};
    ssl_certificate_key ${keyPath};

${authDirectives}${body}
}
`
      : '';
    return `# WPHerd: ${name}
server {
    listen 80;
    server_name ${redirectNames};
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name ${serverNames};

    ssl_certificate ${certPath};
    ssl_certificate_key ${keyPath};

${body}
}
${aliasBlock}`;
  }

  const aliasBlock = splitAliases
    ? `
server {
    listen 80;
    server_name ${aliasNames};

${authDirectives}${body}
}
`
    : '';
  return `# WPHerd: ${name}
server {
    listen 80;
    server_name ${serverNames};

${body}
}
${aliasBlock}`;
}

function createSiteConfig(site) {
  ensureServersDir();
  const serversDir = getServersDir();
  if (!serversDir) throw new Error('nginx servers directory not found');

  const configContent = generateSiteConfig(site);
  const configPath = path.join(serversDir, `${site.domain}.conf`);
  fs.writeFileSync(configPath, configContent, 'utf8');
  return configPath;
}

function removeSiteConfig(domain) {
  const serversDir = getServersDir();
  if (!serversDir) return;
  const configPath = path.join(serversDir, `${domain}.conf`);
  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
  }
}

function siteConfigExists(domain) {
  const serversDir = getServersDir();
  if (!serversDir) return false;
  return fs.existsSync(path.join(serversDir, `${domain}.conf`));
}

function validateConfig() {
  try {
    execSync(`${getNginxBinPath()} -t`, { stdio: 'pipe' });
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.stderr?.toString() || err.message };
  }
}

module.exports = {
  getNginxConfDir,
  getNginxBinPath,
  getServersDir,
  isRunning,
  isRunningAsync,
  start,
  stop,
  restart,
  reload,
  generateSiteConfig,
  createSiteConfig,
  removeSiteConfig,
  siteConfigExists,
  validateConfig,
  ensureServersDir,
};
