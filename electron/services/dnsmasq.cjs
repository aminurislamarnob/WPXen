'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const brew = require('./brew.cjs');
const execAsync = require('./asyncExec.cjs');

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
    // See nginx.isRunning: launchd starts dnsmasq via absolute path, so
    // `pgrep -x` alone misses it — fall back to a full-args path match.
    execSync("pgrep -x dnsmasq || pgrep -f '[/ ]dnsmasq'", { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Non-blocking variant used by the status poller (see asyncExec.cjs).
async function isRunningAsync() {
  try {
    await execAsync("pgrep -x dnsmasq || pgrep -f '[/ ]dnsmasq'", { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

// dnsmasq binds port 53 — must run as a root LaunchDaemon (sudo).
function start() {
  brew.startBrewServiceSudo('dnsmasq');
}

function stop() {
  brew.stopBrewServiceSudo('dnsmasq');
}

function restart() {
  brew.restartBrewServiceSudo('dnsmasq');
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

  // Stage the file content in a temp file (no privileges needed), then use
  // admin rights only to copy it into place. This avoids embedding multi-line
  // content inside nested AppleScript/shell quoting, which silently corrupts
  // the command (the newline splits `echo`, breaking the whole script).
  const tmpFile = path.join(os.tmpdir(), `wpherd-resolver-${TLD}`);
  fs.writeFileSync(tmpFile, resolverContent, 'utf8');

  // Also flush the DNS cache so macOS drops any negative (NXDOMAIN) result it
  // cached for *.test before dnsmasq/the resolver existed. Runs as root in the
  // same privileged step, so killall mDNSResponder succeeds without a 2nd prompt.
  const shellCmd =
    `mkdir -p ${RESOLVER_DIR} && cp '${tmpFile}' '${RESOLVER_FILE}' && chmod 644 '${RESOLVER_FILE}'` +
    ` && dscacheutil -flushcache && killall -HUP mDNSResponder`;
  const appleScript = `do shell script "${shellCmd.replace(/"/g, '\\"')}" with administrator privileges`;
  try {
    execSync(`osascript -e '${appleScript.replace(/'/g, "'\\''")}'`, { stdio: 'pipe' });
  } finally {
    try {
      fs.rmSync(tmpFile, { force: true });
    } catch {}
  }
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
  isRunningAsync,
  start,
  stop,
  restart,
  isConfigured,
  configureDnsmasq,
  resolverFileExists,
  setupComplete,
};
