import { describe, it, expect } from 'vitest';
import mysql from '../electron/services/mysql.cjs';

describe('sqlImportStartOffset', () => {
  it('skips the MariaDB sandbox-mode marker line', () => {
    const dump = '/*!999999\\- enable the sandbox mode */ \n-- MariaDB dump\nSELECT 1;';
    const offset = mysql.sqlImportStartOffset(Buffer.from(dump));
    expect(dump.slice(offset).startsWith('-- MariaDB dump')).toBe(true);
  });

  it('returns 0 for a standard mysqldump header', () => {
    const dump = '-- MySQL dump 10.13  Distrib 8.0.36\nSELECT 1;';
    expect(mysql.sqlImportStartOffset(Buffer.from(dump))).toBe(0);
  });

  it('returns 0 when the marker never ends in the sampled head', () => {
    expect(mysql.sqlImportStartOffset(Buffer.from('/*!999999\\- no newline'))).toBe(0);
  });

  it('returns 0 for an empty buffer', () => {
    expect(mysql.sqlImportStartOffset(Buffer.alloc(0))).toBe(0);
  });
});

describe('isDumpSessionOverrideLine', () => {
  it('flags SET @@GLOBAL.GTID_PURGED', () => {
    expect(
      mysql.isDumpSessionOverrideLine(
        "SET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ '3E11FA47-71CA-11E1-9E33:1-5';"
      )
    ).toBe(true);
  });

  it('flags SET @@SESSION.SQL_LOG_BIN (header and footer restore)', () => {
    expect(mysql.isDumpSessionOverrideLine('SET @@SESSION.SQL_LOG_BIN= 0;')).toBe(true);
    expect(
      mysql.isDumpSessionOverrideLine(
        'SET @@SESSION.SQL_LOG_BIN = @MYSQLDUMP_TEMP_LOG_BIN;'
      )
    ).toBe(true);
  });

  it('tolerates leading whitespace', () => {
    expect(mysql.isDumpSessionOverrideLine("   SET @@GLOBAL.GTID_PURGED='x';")).toBe(
      true
    );
  });

  it('leaves ordinary statements untouched', () => {
    expect(mysql.isDumpSessionOverrideLine('SET @MYSQLDUMP_TEMP_LOG_BIN = 1;')).toBe(
      false
    );
    expect(mysql.isDumpSessionOverrideLine("INSERT INTO t VALUES ('GTID_PURGED');")).toBe(
      false
    );
    expect(mysql.isDumpSessionOverrideLine('SET NAMES utf8mb4;')).toBe(false);
  });
});
