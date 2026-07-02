'use strict';

const { execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
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
};
