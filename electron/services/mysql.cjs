'use strict';

const { execFileSync, execFile, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const zlib = require('zlib');
const brew = require('./brew.cjs');
const procman = require('./procman.cjs');

// execFile (no shell) for every call that includes user-influenced values —
// the DB name or root password. This removes the command-injection surface
// that string-interpolated shell commands would otherwise expose.
const execFileAsync = promisify(execFile);

// DB credentials used for all root-level operations. Defaults to a
// passwordless root (fresh Homebrew installs); overridden from settings.
let credentials = { user: 'root', password: '' };

function setCredentials({ user, password } = {}) {
  credentials = {
    user: user || 'root',
    password: password || '',
  };
}

function getCredentials() {
  return { ...credentials };
}

// Builds the auth flags shared by mysql / mysqladmin invocations.
function authArgs() {
  const args = ['-u', credentials.user];
  if (credentials.password) args.push(`-p${credentials.password}`);
  return args;
}

function getMysqlBin() {
  const prefix = brew.getBrewPrefix();
  if (!prefix) return 'mysql';
  // Check mariadb first, then mysql
  const candidates = [`${prefix}/bin/mariadb`, `${prefix}/bin/mysql`, 'mysql'];
  const fs = require('fs');
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'mysql';
}

function getMysqladminBin() {
  const prefix = brew.getBrewPrefix();
  if (!prefix) return 'mysqladmin';
  const fs = require('fs');
  const candidates = [
    `${prefix}/bin/mariadb-admin`,
    `${prefix}/bin/mysqladmin`,
    'mysqladmin',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'mysqladmin';
}

function getMysqldumpBin() {
  const prefix = brew.getBrewPrefix();
  if (!prefix) return 'mysqldump';
  const candidates = [
    `${prefix}/bin/mariadb-dump`,
    `${prefix}/bin/mysqldump`,
    'mysqldump',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'mysqldump';
}

// Argv for a consistent dump of one database. Exported (pure) for tests.
function buildDumpArgs(dbName, creds = credentials) {
  const args = ['-u', creds.user];
  if (creds.password) args.push(`-p${creds.password}`);
  args.push('--single-transaction', '--routines', '--triggers', dbName);
  return args;
}

// Streams `mysqldump <db>` through gzip into destGzPath. Argv-only (no shell),
// matching this module's injection stance; rejects with the stderr tail on a
// nonzero exit and removes the partial file.
function dumpDatabase(dbName, destGzPath) {
  assertSafeDbName(dbName);
  return new Promise((resolve, reject) => {
    const child = spawn(getMysqldumpBin(), buildDumpArgs(dbName), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = fs.createWriteStream(destGzPath, { mode: 0o600 });
    let stderrTail = '';
    let exitCode = null;
    let finished = false;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try {
        fs.unlinkSync(destGzPath);
      } catch {}
      reject(err);
    };
    // Settle only once the process exited AND the gzip stream fully flushed,
    // so a resolved promise always means a complete file on disk.
    const trySettle = () => {
      if (settled || exitCode === null || !finished) return;
      if (exitCode === 0) {
        settled = true;
        resolve(destGzPath);
      } else {
        fail(new Error(stderrTail.trim() || `mysqldump exited (code ${exitCode}).`));
      }
    };

    child.stderr.on('data', (b) => {
      stderrTail = (stderrTail + b.toString()).slice(-4000);
    });
    // pipe() does not forward errors between stages, so the gzip transform
    // needs its own handler or a stream error would go unhandled and crash.
    const gzip = zlib.createGzip();
    gzip.on('error', fail);
    child.stdout.pipe(gzip).pipe(out);
    child.on('error', fail);
    out.on('error', fail);
    child.on('close', (code) => {
      exitCode = code;
      trySettle();
    });
    out.on('finish', () => {
      finished = true;
      trySettle();
    });
  });
}

// Streams a gzipped SQL dump into `mysql <db>` via stdin.
function importDatabase(dbName, srcGzPath) {
  assertSafeDbName(dbName);
  return new Promise((resolve, reject) => {
    const child = spawn(getMysqlBin(), [...authArgs(), dbName], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderrTail = '';
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {}
      reject(err);
    };

    child.stderr.on('data', (b) => {
      stderrTail = (stderrTail + b.toString()).slice(-4000);
    });
    // An early mysql exit EPIPEs stdin — swallow it, the close handler carries
    // the real error from stderr.
    child.stdin.on('error', () => {});

    const input = fs.createReadStream(srcGzPath);
    const gunzip = zlib.createGunzip();
    input.on('error', fail);
    gunzip.on('error', fail);
    input.pipe(gunzip).pipe(child.stdin);

    child.on('error', fail);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else reject(new Error(stderrTail.trim() || `mysql exited (code ${code}).`));
    });
  });
}

function getBrewServiceName() {
  if (brew.isPackageInstalled('mariadb')) return 'mariadb';
  if (brew.isPackageInstalled('mysql')) return 'mysql';
  return 'mysql';
}

function isRunning() {
  try {
    execFileSync(getMysqladminBin(), [...authArgs(), 'ping'], {
      stdio: 'pipe',
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

// Non-blocking variant used by the status poller.
async function isRunningAsync() {
  try {
    await execFileAsync(getMysqladminBin(), [...authArgs(), 'ping'], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// Resolves the actual server daemon. We spawn mysqld/mariadbd directly, NOT
// mysqld_safe — that wrapper is itself a supervisor (respawns the server and
// swallows signals), which would fight procman's crash-restart and make
// graceful stop unreliable.
function getServerBin() {
  const prefix = brew.getBrewPrefix();
  if (!prefix) return null;
  const candidates = [
    `${prefix}/opt/mariadb/bin/mariadbd`,
    `${prefix}/opt/mysql/bin/mysqld`,
    `${prefix}/bin/mariadbd`,
    `${prefix}/bin/mysqld`,
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// MySQL runs as a supervised child of WPHerd (see procman.cjs).
function buildSpec() {
  const bin = getServerBin();
  if (!bin) throw new Error('MySQL/MariaDB is not installed.');
  const prefix = brew.getBrewPrefix();
  return {
    name: 'mysql',
    bin,
    // Same datadir the brew service used; the server error log stays at the
    // datadir default (*.err) so existing debugging habits keep working.
    args: [`--datadir=${prefix}/var/mysql`],
    cwd: `${prefix}/var`,
    // Clean shutdown first via mysqladmin (fast, credential-aware)…
    gracefulStop: () =>
      execFileAsync(getMysqladminBin(), [...authArgs(), 'shutdown'], {
        timeout: 20_000,
      }),
    // …falling back to SIGTERM, which mysqld also treats as clean shutdown
    // (covers wrong/changed credentials).
    stopSignal: 'SIGTERM',
    stopTimeoutMs: 15_000,
    // InnoDB recovery can take a few seconds — gate "started" on a real ping
    // so site creation and Start buttons don't race a warming server.
    readyProbe: isRunningAsync,
    readyTimeoutMs: 30_000,
    conflictProbe: isRunningAsync,
    takeover: async () => {
      try {
        brew.stopBrewService(getBrewServiceName());
      } catch {}
    },
  };
}

function start() {
  return procman.start(buildSpec());
}

function stop() {
  return procman.stop('mysql');
}

function restart() {
  return procman.restart(buildSpec());
}

function execQuery(sql, opts = {}) {
  const args = [...authArgs()];
  if (opts.database) args.push(opts.database);
  args.push('-e', sql);
  // execFile: the SQL is a single argv token, never parsed by a shell.
  return execFileSync(getMysqlBin(), args, { stdio: 'pipe', timeout: 10000 })
    .toString()
    .trim();
}

// A MySQL identifier we're willing to interpolate into SQL. Names are generated
// from a validated slug ([a-z0-9_]); reject anything else so a stored/edited
// value can never smuggle a backtick and break out of the identifier quoting.
function assertSafeDbName(dbName) {
  if (typeof dbName !== 'string' || !/^[a-zA-Z0-9_]{1,64}$/.test(dbName)) {
    throw new Error(`Unsafe database name: ${dbName}`);
  }
  return dbName;
}

function databaseExists(dbName) {
  assertSafeDbName(dbName);
  try {
    const result = execQuery(`SHOW DATABASES LIKE '${dbName}';`);
    return result.includes(dbName);
  } catch {
    return false;
  }
}

function createDatabase(dbName) {
  assertSafeDbName(dbName);
  execQuery(
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
  );
}

function dropDatabase(dbName) {
  assertSafeDbName(dbName);
  execQuery(`DROP DATABASE IF EXISTS \`${dbName}\`;`);
}

function listDatabases() {
  try {
    const result = execQuery('SHOW DATABASES;');
    return result
      .split('\n')
      .slice(1)
      .filter(
        (db) =>
          db.trim() &&
          !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(
            db.trim()
          )
      );
  } catch {
    return [];
  }
}

// Returns the Unix socket the server is listening on (via @@socket), or null.
// Used so phpMyAdmin connects the same way the CLI does — matching the
// 'user'@'localhost' grant rather than a TCP grant that may not exist.
function getSocketPath() {
  try {
    const out = execQuery('SELECT @@socket;');
    const lines = out.split('\n').filter((l) => l.trim());
    const value = lines[lines.length - 1]?.trim();
    return value && value !== '@@socket' ? value : null;
  } catch {
    return null;
  }
}

function testConnection() {
  try {
    execQuery('SELECT 1;');
    return { connected: true };
  } catch (err) {
    return { connected: false, error: err.message };
  }
}

module.exports = {
  isRunning,
  isRunningAsync,
  start,
  stop,
  restart,
  createDatabase,
  dropDatabase,
  databaseExists,
  listDatabases,
  testConnection,
  getBrewServiceName,
  execQuery,
  getSocketPath,
  setCredentials,
  getCredentials,
  getMysqldumpBin,
  buildDumpArgs,
  dumpDatabase,
  importDatabase,
};
