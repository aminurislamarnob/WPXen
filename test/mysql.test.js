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
