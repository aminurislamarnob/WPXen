'use strict';

const { execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const brew = require('./brew.cjs');

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

function start() {
  brew.startBrewService(getBrewServiceName());
}

function stop() {
  brew.stopBrewService(getBrewServiceName());
}

function restart() {
  brew.restartBrewService(getBrewServiceName());
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
  setCredentials,
  getCredentials,
};
