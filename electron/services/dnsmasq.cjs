'use strict';

// Routes *.test to this machine. Two DNS modes exist while installs move over
// (spec #201):
//
//   rootless — dnsmasq is a supervised procman child of the app, run as the
//              user, in the foreground, on a high loopback port, reading only
//              a WPXen-owned config in the app's data folder. The resolver
//              file is the one privileged write. Fresh installs land here.
//   legacy   — the old setup: a root LaunchDaemon on port 53 via
//              `brew services`, configured through Homebrew's shared
//              dnsmasq.conf. Installs that already have it stay on it, and it
//              starts and stops exactly as before, until they migrate.
//
// The mode is recorded in the store. Legacy is recorded the moment it is
// detected (so the install can't drift out of it); rootless only once its
// setup has succeeded. Legacy installs move to rootless through
// migrateToRootless(), offered by an in-app notice (#203).

const { execSync } = require('child_process');
const dgram = require('dgram');
const dnsPromises = require('dns').promises;
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const brew = require('./brew.cjs');
const procman = require('./procman.cjs');
const execAsync = require('./asyncExec.cjs');
const sudoers = require('./sudoers.cjs');
const { adminOsascript } = require('./admin.cjs');

const TLD = 'test';
const LOOPBACK = '127.0.0.1';
const RESOLVER_DIR = '/etc/resolver';
const RESOLVER_FILE = `/etc/resolver/${TLD}`;

// ─── Names written outside the bundle ──────────────────────────────────────
// A future rename has to find these. The resolver file's comment line is the
// only name-carrying text in a root-owned file; the config and pid files live
// in the app's data folder (`<userData>/dnsmasq/`).
const DNS_PORT = 53535; // default high port; avoids 5353 (mDNS)
const RESOLVER_COMMENT = `# WPXen DNS resolver for .${TLD} domains`;
const CONF_DIR_NAME = 'dnsmasq';
const CONF_FILE_NAME = 'wpxen-dnsmasq.conf';
const PID_FILE_NAME = 'wpxen-dnsmasq.pid';
const RESOLVER_STAGING_NAME = `wpxen-resolver-${TLD}`;

// The legacy setup's marker in Homebrew's shared dnsmasq.conf. Its comment
// line carried whichever app name was current at setup time (WPHerd,
// WPDevPilot, WPXen); the address line is the same under every name.
const LEGACY_ADDRESS_LINE = `address=/.${TLD}/${LOOPBACK}`;
const LEGACY_CONF_COMMENT = `# WPXen: Route *.${TLD} to localhost`;
const LEGACY_CONF_COMMENT_NAMES = ['WPXen', 'WPDevPilot', 'WPHerd'];

// What `sudo brew services` registered for the legacy daemon. Homebrew's
// names, not ours: migration unregisters it.
const ROOT_SERVICE_LABEL = 'homebrew.mxcl.dnsmasq';
const ROOT_SERVICE_PLIST = `/Library/LaunchDaemons/${ROOT_SERVICE_LABEL}.plist`;

// Every sudoers file any app generation installed. Migration deletes all of
// them in its one privileged step — each is a live NOPASSWD grant.
const ALL_SUDOERS_PATHS = [sudoers.SUDOERS_PATH, ...sudoers.LEGACY_SUDOERS_PATHS];

// Store keys (top-level `dns` object in wpxen-data.json).
const MODE_KEY = 'dns.mode';
const PORT_KEY = 'dns.port';
const MODES = ['legacy', 'rootless'];

// The reserved name: the ready probe asks our own instance for it directly,
// the health check asks the system resolver. Under .test, so dnsmasq answers
// it from config without any upstream.
const READY_PROBE_NAME = `wpxen-probe.${TLD}`;

// "Use a different port" scans upward from the default for this many ports.
const PORT_SEARCH_SPAN = 100;
// Lookups tried right after a fix before it is reported as not working.
const SETTLE_ATTEMPTS = 3;

// Everything that touches the machine, swappable from tests (see __setDeps).
// `store` is bound by ipc.cjs at startup.
const deps = {
  store: null,
  execSync,
  procman,
  brew,
  getDataDir: () => procman.getBaseDir(),
  getBrewPrefix: () => brew.getBrewPrefix(),
  getBrewPath: () => brew.getBrewPath(),
  tmpdir: () => os.tmpdir(),
  binExists: (p) => fs.existsSync(p),
  resolverExists: () => fs.existsSync(RESOLVER_FILE),
  legacySetupPresent: () => isLegacyConfigured(),
  // System resolver (getaddrinfo), which honours /etc/resolver/* — unlike
  // dns.resolve*, which asks the DNS servers directly (see cloudflared.cjs).
  lookup: async (name) =>
    (await dnsPromises.lookup(name, { family: 4, all: true })).map((r) => r.address),
  lookupTimeoutMs: 3000,
  // Pause between lookups right after a fix, while macOS picks up the new
  // resolver file (see checkHealth's `settle`).
  settleDelayMs: 1000,
  portInUse: (port) => probePortInUse(port),
  sudoersPresent: () => sudoers.presentPaths().length > 0,
};

function bindStore(store) {
  deps.store = store;
}

// ─── Mode ───────────────────────────────────────────────────────────────────

// Pure: a recorded mode wins; otherwise an existing old-style setup is legacy
// and everything else (never set up, or set up by another tool) is rootless.
function decideMode({ storedMode, legacySetup }) {
  if (MODES.includes(storedMode)) return storedMode;
  return legacySetup ? 'legacy' : 'rootless';
}

function getMode() {
  const storedMode = deps.store ? deps.store.get(MODE_KEY, null) : null;
  if (MODES.includes(storedMode)) return storedMode;
  const mode = decideMode({ storedMode, legacySetup: deps.legacySetupPresent() });
  if (mode === 'legacy' && deps.store) deps.store.set(MODE_KEY, 'legacy');
  return mode;
}

function getPort() {
  const port = deps.store ? deps.store.get(PORT_KEY, null) : null;
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DNS_PORT;
}

// ─── Rootless ───────────────────────────────────────────────────────────────

function getConfDir() {
  return path.join(deps.getDataDir(), CONF_DIR_NAME);
}

function getConfPath() {
  return path.join(getConfDir(), CONF_FILE_NAME);
}

// Prefer the keg's opt path (stable across upgrades) over the linked one.
function getBinPath() {
  const prefix = deps.getBrewPrefix();
  if (!prefix) return null;
  const optPath = `${prefix}/opt/dnsmasq/sbin/dnsmasq`;
  if (deps.binExists(optPath)) return optPath;
  const linkedPath = `${prefix}/sbin/dnsmasq`;
  if (deps.binExists(linkedPath)) return linkedPath;
  return null;
}

// The DNS content. Listening (address, port, interface binding) lives in the
// spec's args so the port can change without touching this file.
function buildConfig() {
  return (
    '# WPXen dnsmasq config — generated on every start, do not edit.\n' +
    `# Answers *.${TLD} with the loopback address and nothing else.\n` +
    // Only .test queries are routed here, so there is no upstream to ask,
    // and nothing from /etc/hosts belongs in the answers.
    'no-resolv\n' +
    'no-hosts\n' +
    'no-poll\n' +
    `address=/.${TLD}/${LOOPBACK}\n`
  );
}

function buildResolverContent({ port = getPort() } = {}) {
  return `${RESOLVER_COMMENT}\nnameserver ${LOOPBACK}\nport ${port}\n`;
}

function writeConfig() {
  fs.mkdirSync(getConfDir(), { recursive: true });
  fs.writeFileSync(getConfPath(), buildConfig(), 'utf8');
}

// Ready once our instance answers the probe name with the loopback address.
// Asks the port directly (c-ares), not the system resolver — whether macOS
// routes .test here is a separate question.
async function answersOnPort(port) {
  try {
    const resolver = new dnsPromises.Resolver({ timeout: 1000, tries: 1 });
    resolver.setServers([`${LOOPBACK}:${port}`]);
    const addrs = await resolver.resolve4(READY_PROBE_NAME);
    return addrs.includes(LOOPBACK);
  } catch {
    return false;
  }
}

// dnsmasq as an ordinary child of the app (see procman.cjs). No conflictProbe
// or takeover: any other dnsmasq on the machine (the legacy root daemon, the
// user's own) is on another port and isn't ours to stop.
function buildSpec() {
  const bin = getBinPath();
  if (!bin) throw new Error('dnsmasq is not installed.');
  const port = getPort();
  const confDir = getConfDir();
  return {
    name: 'dnsmasq',
    bin,
    args: [
      '--keep-in-foreground',
      // Replaces the compiled-in default, so Homebrew's shared dnsmasq.conf
      // is never read.
      `--conf-file=${getConfPath()}`,
      `--listen-address=${LOOPBACK}`,
      `--port=${port}`,
      '--bind-interfaces',
      // The default pid file is /var/run/dnsmasq.pid, which a non-root
      // process can't write. Kept apart from procman's own run/dnsmasq.pid.
      `--pid-file=${path.join(confDir, PID_FILE_NAME)}`,
      // stderr, which procman captures into the service log.
      '--log-facility=-',
    ],
    cwd: confDir,
    stopSignal: 'SIGTERM',
    stopTimeoutMs: 5000,
    readyProbe: () => answersOnPort(port),
    readyTimeoutMs: 10_000,
    meta: { mode: 'rootless', port },
  };
}

// The one privileged step: stage the resolver content unprivileged, then copy
// it into place as root. Staging avoids embedding multi-line content inside
// nested AppleScript/shell quoting, which silently corrupts the command. The
// DNS cache flush rides in the same step so macOS drops any negative result
// it cached for *.test, without a second prompt.
//
// `before` is shell run as root ahead of the resolver write, in the same
// prompt (migration's stop-and-cleanup); `reason` is the dialog text.
function writeResolverFile(
  content,
  {
    before = [],
    reason = `WPXen wants to configure macOS so that .${TLD} sites resolve to your ` +
      'local machine.',
  } = {}
) {
  const tmpFile = path.join(deps.tmpdir(), RESOLVER_STAGING_NAME);
  fs.writeFileSync(tmpFile, content, 'utf8');
  const shellCmd = [
    ...before,
    `mkdir -p ${RESOLVER_DIR} && cp '${tmpFile}' '${RESOLVER_FILE}' && chmod 644 '${RESOLVER_FILE}'` +
      ` && dscacheutil -flushcache && killall -HUP mDNSResponder`,
  ].join(' && ');
  try {
    deps.execSync(adminOsascript(shellCmd, reason), { stdio: 'pipe' });
  } finally {
    try {
      fs.rmSync(tmpFile, { force: true });
    } catch {}
  }
}

function configureRootless({ port = getPort() } = {}) {
  writeConfig();
  // Throws on a cancelled prompt — nothing is recorded then.
  writeResolverFile(buildResolverContent({ port }));
  if (deps.store) {
    deps.store.set(PORT_KEY, port);
    deps.store.set(MODE_KEY, 'rootless');
  }
}

// ─── Legacy ─────────────────────────────────────────────────────────────────

function getSharedConfPath() {
  const prefix = deps.getBrewPrefix();
  if (!prefix) return null;
  return `${prefix}/etc/dnsmasq.conf`;
}

// The old setup: our address line in Homebrew's shared config, plus the
// resolver file.
function isLegacyConfigured() {
  const confPath = getSharedConfPath();
  if (!confPath || !fs.existsSync(confPath)) return false;
  const content = fs.readFileSync(confPath, 'utf8');
  return content.includes(LEGACY_ADDRESS_LINE) && deps.resolverExists();
}

function configureLegacy() {
  const confPath = getSharedConfPath();
  if (!confPath) throw new Error('dnsmasq config path not found');

  let content = '';
  if (fs.existsSync(confPath)) {
    content = fs.readFileSync(confPath, 'utf8');
  }
  if (!content.includes(LEGACY_ADDRESS_LINE)) {
    content += `\n${LEGACY_CONF_COMMENT}\n${LEGACY_ADDRESS_LINE}\n`;
    fs.writeFileSync(confPath, content, 'utf8');
  }
  writeResolverFile(`${RESOLVER_COMMENT}\nnameserver ${LOOPBACK}\n`);
}

// Legacy dnsmasq is found by process name: the root daemon isn't our child.
async function isLegacyRunningAsync() {
  try {
    // launchd starts dnsmasq via absolute path, so `pgrep -x` alone misses
    // it — fall back to a full-args path match.
    await execAsync("pgrep -x dnsmasq || pgrep -f '[/ ]dnsmasq'", { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

// ─── Health ─────────────────────────────────────────────────────────────────
// A running process proves nothing on its own: the resolver file can be gone,
// stale (wrong port) or overwritten by another tool. DNS is healthy only when
// the reserved name resolves, through the system resolver, to the loopback
// address.

// Pure: the verdict for one lookup — its addresses, or the error it threw.
function decideHealth({ addresses, error } = {}) {
  if (error) {
    const why = error.code || error.message || 'lookup failed';
    return {
      healthy: false,
      message: `.${TLD} names don't resolve on this Mac (${why}).`,
    };
  }
  const list = Array.isArray(addresses) ? addresses : [];
  if (list.length > 0 && list.every((a) => a === LOOPBACK)) {
    return { healthy: true, message: null };
  }
  return {
    healthy: false,
    message: list.length
      ? `.${TLD} names resolve to ${list.join(', ')} instead of ${LOOPBACK}.`
      : `.${TLD} names resolve to nothing.`,
  };
}

// state:   unknown (never checked) | unconfigured | healthy | error
// problem: null | 'lookup' (→ Repair) | 'port-conflict' (→ Use a different port)
const UNKNOWN_HEALTH = Object.freeze({
  state: 'unknown',
  problem: null,
  message: null,
  addresses: null,
  port: null,
  checkedAt: null,
});

let health = { ...UNKNOWN_HEALTH };
let checkInFlight = null;

function setHealth(next) {
  health = { ...UNKNOWN_HEALTH, ...next, checkedAt: Date.now() };
  return health;
}

// getaddrinfo has no timeout of its own, and a resolver file pointing at a
// dead port can keep it waiting for a long time.
function lookupWithTimeout(name) {
  const ms = deps.lookupTimeoutMs;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error('lookup timed out'), { code: 'timed out' })),
      ms
    );
  });
  return Promise.race([Promise.resolve().then(() => deps.lookup(name)), timeout]).finally(
    () => clearTimeout(timer)
  );
}

// Resolves the reserved name through the system resolver and records the
// verdict — in either mode, since the question ("does .test reach this Mac?")
// is the same. Before DNS has been set up there is nothing to check.
// Concurrent callers share one lookup. Right after a fix (`settle`), a bad
// result is retried a few times before it is reported.
async function lookupOnce() {
  try {
    const addresses = await lookupWithTimeout(READY_PROBE_NAME);
    const verdict = decideHealth({ addresses });
    return {
      state: verdict.healthy ? 'healthy' : 'error',
      problem: verdict.healthy ? null : 'lookup',
      message: verdict.message,
      addresses,
    };
  } catch (error) {
    return {
      state: 'error',
      problem: 'lookup',
      message: decideHealth({ error }).message,
    };
  }
}

function checkHealth({ settle = false } = {}) {
  if (checkInFlight) {
    // Join a check already running — unless this one follows a fix and that
    // one won't settle: it may have started before the fix and would hand
    // back a stale verdict with no retries. Look again once it is done.
    if (checkInFlight.settle || !settle) return checkInFlight.promise;
    return checkInFlight.promise.then(() => checkHealth({ settle }));
  }
  const attempts = settle ? SETTLE_ATTEMPTS : 1;
  const promise = (async () => {
    if (!hasBeenSetUp()) return setHealth({ state: 'unconfigured' });
    // A port held by another program is the cause; the failing lookup that
    // follows from it is only a symptom, and would hide the right fix.
    if (health.problem === 'port-conflict' && !ownChildAlive()) return getHealth();
    let result = await lookupOnce();
    for (let i = 1; i < attempts && result.state !== 'healthy'; i++) {
      await new Promise((r) => setTimeout(r, deps.settleDelayMs));
      result = await lookupOnce();
    }
    return setHealth(result);
  })().finally(() => {
    checkInFlight = null;
  });
  checkInFlight = { promise, settle };
  return promise;
}

// The status poller's re-check, so a resolver file deleted or overwritten
// while the app runs shows up without a relaunch. Only once the launch (or
// setup) check has seeded a result — before that dnsmasq may still be coming
// up — and no more often than maxAgeMs.
function refreshHealth({ maxAgeMs }) {
  if (health.checkedAt == null) return Promise.resolve(getHealth());
  if (Date.now() - health.checkedAt < maxAgeMs) return Promise.resolve(getHealth());
  return checkHealth();
}

function getHealth() {
  return { ...health };
}

// What the status poller merges into the dnsmasq entry: the last check, the
// one-click fix it calls for, and the message to show.
function getStatusFields() {
  const action =
    health.problem === 'port-conflict'
      ? 'change-port'
      : health.problem === 'lookup'
        ? 'repair'
        : null;
  return {
    health: getHealth(),
    action,
    error: health.state === 'error' ? health.message : null,
  };
}

// Setup has happened once a mode is recorded (legacy on detection, rootless
// on success). Deliberately not "the resolver file exists": a deleted
// resolver file is exactly what the check must catch.
function hasBeenSetUp() {
  getMode();
  return !!deps.store && MODES.includes(deps.store.get(MODE_KEY, null));
}

// ─── Port conflict (rootless) ───────────────────────────────────────────────

// True when another program already holds the loopback port, over UDP or TCP
// (dnsmasq binds both and exits on either failing). Binds and releases
// immediately.
function probePortInUse(port) {
  const udp = new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', () => {
      try {
        sock.close();
      } catch {}
      resolve(true);
    });
    sock.bind(port, LOOPBACK, () => sock.close(() => resolve(false)));
  });
  const tcp = new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.listen({ port, host: LOOPBACK, exclusive: true }, () =>
      server.close(() => resolve(false))
    );
  });
  return Promise.all([udp, tcp]).then(([u, t]) => u || t);
}

function ownChildAlive() {
  return !!deps.procman.status('dnsmasq').pid;
}

function portConflictError(port) {
  const err = new Error(
    `Port ${port} is in use by another program, so DNS can’t start. Use a different port to fix it.`
  );
  err.code = 'DNS_PORT_IN_USE';
  err.port = port;
  return err;
}

// Starts our child, probing the port first unless our own instance is the
// one holding it. A taken port becomes an error state with its own fix,
// rather than a spawn that procman would crash-restart until it gave up.
async function startRootless() {
  const port = getPort();
  if (!ownChildAlive() && (await deps.portInUse(port))) {
    const err = portConflictError(port);
    setHealth({ state: 'error', problem: 'port-conflict', port, message: err.message });
    throw err;
  }
  writeConfig();
  await deps.procman.start(buildSpec());
  // The cause is gone; the next lookup check decides health again. Marked
  // "checked long ago" rather than never-checked, so the status poller's
  // refreshHealth looks again on its next tick.
  if (health.problem === 'port-conflict') health = { ...UNKNOWN_HEALTH, checkedAt: 0 };
}

// First free high port above the default, never the one in use now.
async function pickFreePort({ exclude } = {}) {
  for (let port = DNS_PORT + 1; port <= DNS_PORT + PORT_SEARCH_SPAN; port++) {
    if (port === exclude) continue;
    if (!(await deps.portInUse(port))) return port;
  }
  throw new Error('No free port found for DNS. Quit the program using it and try again.');
}

// "Use a different port": pick a free port, rewrite the resolver file for it
// (the one prompt), persist it — only once the prompt succeeded — and bring
// dnsmasq up there.
async function useDifferentPort() {
  if (getMode() !== 'rootless') {
    throw new Error('Legacy DNS runs on port 53; migrate to change how DNS runs.');
  }
  const port = await pickFreePort({ exclude: getPort() });
  configureRootless({ port }); // throws on cancel: old port kept
  await deps.procman.stop('dnsmasq');
  await startRootless();
  return { port, health: await checkHealth({ settle: true }) };
}

// Repair: redo setup — config file and resolver file in one prompt — then
// restart and look again. In legacy mode this is the legacy setup.
async function repair() {
  configureDnsmasq();
  await restart();
  return checkHealth({ settle: true });
}

// ─── Migration (legacy → rootless) ─────────────────────────────────────────

// Pure: drops the block configureLegacy() appended to the shared config —
// the comment line under any app generation's name and the address line
// right after it — plus the newline the append started with, when that
// newline is ours to take: the blank line before the block, or (block at the
// end of the file) the terminator added to a last line that had none.
// Everything else stays byte-for-byte; an address line not under our
// comment isn't provably ours and is left.
const escapeRe = (str) => str.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const LEGACY_BLOCK_RE = new RegExp(
  `(^|\\n)# (?:${LEGACY_CONF_COMMENT_NAMES.join('|')}): ` +
    `${escapeRe(`Route *.${TLD} to localhost`)}\\n${escapeRe(LEGACY_ADDRESS_LINE)}(?:\\n|$)`
);

function removeLegacyConfLines(content) {
  let out = content;
  for (let m = out.match(LEGACY_BLOCK_RE); m; m = out.match(LEGACY_BLOCK_RE)) {
    const end = m.index + m[0].length;
    const lead = m[1];
    const blankBefore = m.index === 0 || out[m.index - 1] === '\n';
    // Keep the lead newline when it still terminates the line above.
    const keep = lead && !blankBefore && end < out.length ? lead : '';
    out = out.slice(0, m.index) + keep + out.slice(end);
  }
  return out;
}

// No root needed: Homebrew keeps its prefix user-owned.
function cleanSharedConfig() {
  const confPath = getSharedConfPath();
  if (!confPath || !fs.existsSync(confPath)) return;
  const content = fs.readFileSync(confPath, 'utf8');
  const cleaned = removeLegacyConfLines(content);
  if (cleaned !== content) fs.writeFileSync(confPath, cleaned, 'utf8');
}

// Shown as an in-app notice while true. Legacy installs need it; so does a
// rootless install that still carries a sudoers grant (Settings no longer
// has a control that could remove one).
function migrationNeeded() {
  return getMode() === 'legacy' || deps.sudoersPresent();
}

// Shell run as root to take the legacy daemon down for good. `brew services
// stop` both unloads the LaunchDaemon and deletes its plist; the bootout and
// the rm cover a brew that refuses or a job it no longer knows about.
function buildRootServiceStop() {
  const brewBin = deps.getBrewPath();
  const steps = [];
  if (brewBin) {
    steps.push(`PATH=${deps.getBrewPrefix()}/bin:$PATH ${brewBin} services stop dnsmasq`);
  }
  steps.push(`launchctl bootout system/${ROOT_SERVICE_LABEL}`, 'true');
  return `(${steps.join(' || ')}) && rm -f '${ROOT_SERVICE_PLIST}'`;
}

// One click, one prompt: stop and unregister the root dnsmasq (legacy only —
// on a rootless install any root dnsmasq is the user's own), delete every
// sudoers file, and rewrite the resolver with the port. Throws on a
// cancelled prompt or a failed step, and nothing is recorded then.
//
// After it succeeds: WPXen's lines come out of the shared config, the mode
// is recorded, then the rootless child starts. The mode is recorded before
// the start on purpose — the root daemon is gone and the resolver names the
// high port, so a start failure is a rootless problem to retry, not a reason
// to fall back to a legacy setup that no longer exists.
async function migrateToRootless() {
  const port = getPort();
  // Fails fast (no prompt) when dnsmasq isn't installed.
  buildSpec();
  writeConfig();

  const before = [];
  if (getMode() === 'legacy') before.push(buildRootServiceStop());
  before.push(`rm -f ${ALL_SUDOERS_PATHS.map((p) => `'${p}'`).join(' ')}`);
  writeResolverFile(buildResolverContent({ port }), {
    before,
    reason:
      `WPXen wants to move .${TLD} DNS off its root service and remove the ` +
      'passwordless permission it installed. It will not need your password for ' +
      'DNS again.',
  });

  try {
    cleanSharedConfig();
  } catch (err) {
    // Rootless never reads that file; leftover lines there are cosmetic.
    console.warn('[dnsmasq] could not clean the shared config:', err.message);
  }
  if (deps.store) {
    deps.store.set(PORT_KEY, port);
    deps.store.set(MODE_KEY, 'rootless');
  }
  // Probes the port first: a taken one surfaces as the port-conflict fix.
  await startRootless();
}

// ─── Public, mode-aware ─────────────────────────────────────────────────────

async function start() {
  if (getMode() === 'legacy') {
    // Binds port 53 — a root LaunchDaemon. Uses an existing sudoers grant
    // until migration deletes it; WPXen can no longer install one.
    deps.brew.startBrewServiceSudo('dnsmasq');
    return;
  }
  await startRootless();
}

async function stop() {
  if (getMode() === 'legacy') {
    deps.brew.stopBrewServiceSudo('dnsmasq');
    return;
  }
  await deps.procman.stop('dnsmasq');
}

async function restart() {
  if (getMode() === 'legacy') {
    deps.brew.restartBrewServiceSudo('dnsmasq');
    return;
  }
  // Stop, then start: the port probe has to run once our instance has let go
  // of the port, which procman.restart() gives no room for.
  await deps.procman.stop('dnsmasq');
  await startRootless();
}

// Rootless reports the supervisor's view of our own child; a pgrep would
// also count the legacy root daemon or the user's own dnsmasq.
async function isRunningAsync() {
  if (getMode() === 'legacy') return isLegacyRunningAsync();
  return deps.procman.status('dnsmasq').state === 'running';
}

function isConfigured() {
  if (getMode() === 'legacy') return deps.legacySetupPresent();
  return !!deps.store && deps.store.get(MODE_KEY, null) === 'rootless';
}

// Writes whatever the current mode needs, with one admin prompt. Throws if
// the prompt is cancelled or the step fails.
function configureDnsmasq() {
  if (getMode() === 'legacy') configureLegacy();
  else configureRootless();
}

function resolverFileExists() {
  return deps.resolverExists();
}

function setupComplete() {
  return isConfigured() && resolverFileExists();
}

// Launch brings up rootless dnsmasq once DNS has been set up, whatever the
// services.autoStart preference says: without it no *.test Site resolves. The
// legacy root daemon is launchd's to start.
function shouldAutoStart() {
  return getMode() === 'rootless' && setupComplete();
}

// Test hook: swap collaborators (see `deps` above).
function __setDeps(next) {
  Object.assign(deps, next);
}

// Test hook: forget the last health result between tests.
function __resetHealth() {
  health = { ...UNKNOWN_HEALTH };
  checkInFlight = null;
}

module.exports = {
  TLD,
  DNS_PORT,
  RESOLVER_FILE,
  CONF_FILE_NAME,
  LEGACY_ADDRESS_LINE,
  bindStore,
  decideMode,
  getMode,
  getPort,
  getConfPath,
  buildConfig,
  buildResolverContent,
  buildSpec,
  isRunningAsync,
  start,
  stop,
  restart,
  isConfigured,
  configureDnsmasq,
  resolverFileExists,
  setupComplete,
  shouldAutoStart,
  decideHealth,
  checkHealth,
  refreshHealth,
  getHealth,
  getStatusFields,
  probePortInUse,
  useDifferentPort,
  repair,
  removeLegacyConfLines,
  migrationNeeded,
  migrateToRootless,
  __setDeps,
  __resetHealth,
};
