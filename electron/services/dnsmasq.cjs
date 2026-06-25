'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const brew = require('./brew.cjs');

const TLD = 'test';
const RESOLVER_DIR = '/etc/resolver';
const RESOLVER_FILE = `/etc/resolver/${TLD}`;

function getDnsmasqConfPath() {
  const prefix = brew.getBrewPrefix();
  if (!prefix) return null;
  return `${prefix}/etc/dnsmasq.conf`;
}

function isRunning() {
  try {
    const out = execSync('pgrep -x dnsmasq', { stdio: 'pipe' }).toString().trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

function start() {
  brew.startBrewService('dnsmasq');
}

function stop() {
  brew.stopBrewService('dnsmasq');
}

function restart() {
  brew.restartBrewService('dnsmasq');
}

function isConfigured() {
  const confPath = getDnsmasqConfPath();
  if (!confPath || !fs.existsSync(confPath)) return false;

  const content = fs.readFileSync(confPath, 'utf8');
  const hasTestAddress = content.includes(`address=/.${TLD}/127.0.0.1`);
  const hasResolver = fs.existsSync(RESOLVER_FILE);

  return hasTestAddress && hasResolver;
}

function configureDnsmasq() {
  const confPath = getDnsmasqConfPath();
  if (!confPath) throw new Error('dnsmasq config path not found');

  // Add .test address to dnsmasq.conf
  let content = '';
  if (fs.existsSync(confPath)) {
    content = fs.readFileSync(confPath, 'utf8');
  }

  const addressLine = `address=/.${TLD}/127.0.0.1`;
  if (!content.includes(addressLine)) {
    content += `\n# WPHerd: Route *.${TLD} to localhost\n${addressLine}\n`;
    fs.writeFileSync(confPath, content, 'utf8');
  }

  // Create /etc/resolver/test (requires sudo)
  createResolverFile();
}

function createResolverFile() {
  const resolverContent = `# WPHerd DNS resolver for .${TLD} domains\nnameserver 127.0.0.1\n`;

  // Use osascript to run with admin privileges
  const script = `
    do shell script "mkdir -p /etc/resolver && echo '${resolverContent.replace(/'/g, "\\'")}' > ${RESOLVER_FILE}" with administrator privileges
  `;
  execSync(`osascript -e '${script.trim()}'`, { stdio: 'pipe' });
}

function resolverFileExists() {
  return fs.existsSync(RESOLVER_FILE);
}

function setupComplete() {
  return isConfigured() && resolverFileExists();
}

module.exports = {
  TLD,
  isRunning,
  start,
  stop,
  restart,
  isConfigured,
  configureDnsmasq,
  resolverFileExists,
  setupComplete,
};
