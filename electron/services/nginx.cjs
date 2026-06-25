'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const brew = require('./brew.cjs');

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
    const out = execSync('pgrep -x nginx', { stdio: 'pipe' }).toString().trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

function start() {
  brew.startBrewService('nginx');
}

function stop() {
  brew.stopBrewService('nginx');
}

function restart() {
  brew.restartBrewService('nginx');
}

function reload() {
  try {
    const prefix = brew.getBrewPrefix();
    execSync(`${prefix}/bin/nginx -s reload`, { stdio: 'pipe' });
  } catch {
    restart();
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
      const updated = content.replace(
        /(\s*}\s*)$/,
        '\n    include servers/*;\n$1'
      );
      fs.writeFileSync(confFile, updated, 'utf8');
    }
  }
}

function generateSiteConfig(site) {
  const { name, domain, path: sitePath, phpVersion } = site;
  const prefix = brew.getBrewPrefix();
  const socketPath = brew.getPhpFpmSocketPath(phpVersion);
  const logDir = getNginxLogDir();

  return `# WPHerd: ${name}
server {
    listen 80;
    server_name ${domain};
    root ${sitePath};

    index index.php index.html index.htm;

    access_log ${logDir}/${domain}.access.log;
    error_log  ${logDir}/${domain}.error.log;

    location / {
        try_files $uri $uri/ /index.php?$args;
    }

    location ~ \\.php$ {
        try_files $uri =404;
        fastcgi_split_path_info ^(.+\\.php)(/.+)$;
        fastcgi_pass unix:${socketPath};
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        fastcgi_param HTTP_PROXY "";
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
    }
}
`;
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
    const prefix = brew.getBrewPrefix();
    execSync(`${prefix}/bin/nginx -t`, { stdio: 'pipe' });
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.stderr?.toString() || err.message };
  }
}

module.exports = {
  getNginxConfDir,
  getServersDir,
  isRunning,
  start,
  stop,
  restart,
  reload,
  createSiteConfig,
  removeSiteConfig,
  siteConfigExists,
  validateConfig,
  ensureServersDir,
};
