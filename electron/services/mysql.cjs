'use strict';

const { execSync, exec } = require('child_process');
const brew = require('./brew.cjs');

function getMysqlBin() {
  const prefix = brew.getBrewPrefix();
  if (!prefix) return 'mysql';
  // Check mariadb first, then mysql
  const candidates = [
    `${prefix}/bin/mariadb`,
    `${prefix}/bin/mysql`,
    'mysql',
  ];
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
    const mysqladmin = getMysqladminBin();
    execSync(`${mysqladmin} -u root ping`, { stdio: 'pipe', timeout: 3000 });
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
  const mysql = getMysqlBin();
  const args = ['-u', 'root'];
  if (opts.database) args.push(opts.database);
  args.push('-e', sql);
  const cmd = [mysql, ...args.map((a) => `'${a.replace(/'/g, "'\\''")}'`)].join(' ');
  return execSync(cmd, { stdio: 'pipe', timeout: 10000 }).toString().trim();
}

function databaseExists(dbName) {
  try {
    const result = execQuery(`SHOW DATABASES LIKE '${dbName}';`);
    return result.includes(dbName);
  } catch {
    return false;
  }
}

function createDatabase(dbName) {
  execQuery(
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
  );
}

function dropDatabase(dbName) {
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
          !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(db.trim())
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
};
