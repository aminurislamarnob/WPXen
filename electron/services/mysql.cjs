'use strict';

const { execFileSync, execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { Transform } = require('stream');
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

// Builds the auth flags shared by mysql / mysqladmin invocations. The password
// is intentionally NOT passed as `-p<pw>`: the client would then print
// "[Warning] Using a password on the command line interface can be insecure."
// to stderr on every call, which contaminates captured stderr and gets
// surfaced by humanize() as the (misleading) error whenever a command fails.
// It goes through the MYSQL_PWD env instead — see authEnv().
function authArgs() {
  return ['-u', credentials.user];
}

// Environment for mysql/mysqldump/mysqladmin invocations, carrying the password
// via MYSQL_PWD so it never lands on the command line (see authArgs()). Merge
// this into the exec/spawn options' `env`.
function authEnv() {
  return credentials.password
    ? { ...process.env, MYSQL_PWD: credentials.password }
    : process.env;
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
      env: authEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

// Non-blocking variant used by the status poller.
async function isRunningAsync() {
  try {
    await execFileAsync(getMysqladminBin(), [...authArgs(), 'ping'], {
      timeout: 3000,
      env: authEnv(),
    });
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

// MySQL runs as a supervised child of WPDevPilot (see procman.cjs).
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
        env: authEnv(),
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
  return execFileSync(getMysqlBin(), args, {
    stdio: 'pipe',
    timeout: 10000,
    env: authEnv(),
  })
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

// Recent MariaDB dumps start with a `/*!999999\- enable the sandbox mode */`
// line that the Oracle mysql client rejects outright. Given the first bytes of
// a dump, returns the offset imports should start streaming from (0 when the
// marker is absent). Pure — covered by vitest.
function sqlImportStartOffset(headBuffer) {
  const head = headBuffer.toString('utf8');
  if (head.startsWith('/*!999999\\-')) {
    const nl = head.indexOf('\n');
    if (nl !== -1) return nl + 1;
  }
  return 0;
}

// mysqldump run with binlog/GTID enabled writes session statements into the
// dump header that a fresh local server rejects on import:
//   • `SET @@GLOBAL.GTID_PURGED=...` → ERROR 3546 whenever the target's
//     GTID_EXECUTED is non-empty (the usual case for a running server).
//   • `SET @@SESSION.SQL_LOG_BIN= 0` (+ its footer restore) → needs elevated
//     binlog privileges and is meaningless for a one-shot local import.
// Neither belongs in a local restore, so we comment the lines out. Given a
// single dump line, returns true when it should be neutralized. Pure — tested.
function isDumpSessionOverrideLine(line) {
  return (
    /^\s*SET\s+@@(?:GLOBAL\.)?GTID_PURGED\b/i.test(line) ||
    /^\s*SET\s+@@SESSION\.SQL_LOG_BIN\b/i.test(line)
  );
}

// A Transform that comments out the statements above as the dump streams by.
// Operates on raw bytes, splitting only on newlines and decoding just the head
// of each line for the regex test, so binary blob data passes through intact.
const NEWLINE = 0x0a;
const LINE_COMMENT = Buffer.from('-- ');
function makeDumpSanitizer() {
  let buf = Buffer.alloc(0);
  const emit = (push, line) => {
    // Only the short header/footer statements can match; decoding the first 128
    // bytes as latin1 avoids stringifying multi-megabyte extended-insert lines.
    const head = line.subarray(0, Math.min(line.length, 128)).toString('latin1');
    if (isDumpSessionOverrideLine(head)) push(LINE_COMMENT);
    push(line);
  };
  return new Transform({
    transform(chunk, _enc, cb) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      let nl;
      while ((nl = buf.indexOf(NEWLINE)) !== -1) {
        emit((b) => this.push(b), buf.subarray(0, nl + 1)); // keep the newline
        buf = buf.subarray(nl + 1);
      }
      cb();
    },
    flush(cb) {
      if (buf.length) emit((b) => this.push(b), buf);
      cb();
    },
  });
}

// Streams a full dump of one database to `outFile`. spawn (not execFile) —
// dumps are piped straight to disk so multi-GB databases never buffer in
// memory or trip maxBuffer.
function dumpDatabase(dbName, outFile, { timeout = 600000 } = {}) {
  assertSafeDbName(dbName);
  return new Promise((resolve, reject) => {
    const args = [
      ...authArgs(),
      '--single-transaction',
      '--quick',
      '--default-character-set=utf8mb4',
      dbName,
    ];
    const child = spawn(getMysqldumpBin(), args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      env: authEnv(),
    });
    const out = fs.createWriteStream(outFile);
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.stdout.pipe(out);
    child.on('error', reject);
    out.on('error', reject);
    child.on('close', (code) => {
      out.end(() => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `mysqldump exited with code ${code}`));
      });
    });
  });
}

// Streams a .sql file into an (existing) database, skipping the MariaDB
// sandbox-mode marker line when present.
async function importDatabase(dbName, sqlFile, { timeout = 600000 } = {}) {
  assertSafeDbName(dbName);
  const fd = fs.openSync(sqlFile, 'r');
  let start = 0;
  try {
    const head = Buffer.alloc(512);
    const read = fs.readSync(fd, head, 0, 512, 0);
    start = sqlImportStartOffset(head.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return new Promise((resolve, reject) => {
    // Dumps from older/looser servers (and WordPress/WooCommerce schemas like
    // ActionScheduler) carry `datetime DEFAULT '0000-00-00 00:00:00'` columns
    // that a modern server's default strict sql_mode (NO_ZERO_DATE + STRICT_*)
    // rejects with ERROR 1067. These dumps don't set sql_mode themselves, so
    // relaxing it on connect — before the first CREATE TABLE — lets them import
    // unchanged. --init-command runs once per connection at connect time.
    const child = spawn(
      getMysqlBin(),
      [
        ...authArgs(),
        `--init-command=SET SESSION sql_mode='NO_AUTO_VALUE_ON_ZERO'`,
        dbName,
      ],
      {
        stdio: ['pipe', 'ignore', 'pipe'],
        timeout,
        env: authEnv(),
      }
    );
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    const input = fs.createReadStream(sqlFile, { start });
    const sanitizer = makeDumpSanitizer();
    input.on('error', reject);
    sanitizer.on('error', reject);
    // If the client rejects the dump partway through it exits and closes stdin
    // while we're still writing; the resulting EPIPE would otherwise be an
    // unhandled 'error' that crashes the main process. Swallow it — the real
    // failure surfaces via the non-zero exit code + stderr below.
    child.stdin.on('error', () => {});
    input.pipe(sanitizer).pipe(child.stdin);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `mysql import exited with code ${code}`));
    });
  });
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
  dumpDatabase,
  importDatabase,
  sqlImportStartOffset,
  isDumpSessionOverrideLine,
  testConnection,
  getBrewServiceName,
  execQuery,
  getSocketPath,
  setCredentials,
  getCredentials,
};
