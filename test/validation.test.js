import { describe, it, expect } from 'vitest';
import validation from '../electron/services/validation.cjs';

const base = {
  name: 'My Blog',
  domain: 'my-blog.test',
  dbName: 'my_blog_db',
  path: '/Users/dev/Sites/my-blog',
  phpVersion: '8.2',
  adminUser: 'admin',
  adminEmail: 'admin@my-blog.test',
  adminPassword: 'secret',
};

describe('validateSiteInput', () => {
  it('accepts well-formed input', () => {
    expect(validation.validateSiteInput(base).valid).toBe(true);
  });

  it('rejects an empty name', () => {
    expect(validation.validateSiteInput({ ...base, name: '' }).valid).toBe(false);
  });

  describe('domain', () => {
    it.each([
      'foo`rm -rf ~`.test',
      'foo.test; rm -rf /',
      'foo .test',
      'foo$(whoami).test',
      'UPPER.test',
      'foo/bar.test',
      'foo{}.test',
    ])('rejects injection/invalid domain %j', (domain) => {
      expect(validation.validateSiteInput({ ...base, domain }).valid).toBe(false);
    });

    it.each(['a.test', 'my-blog.test', 'sub.domain.test'])(
      'accepts valid domain %j',
      (domain) => {
        expect(validation.validateSiteInput({ ...base, domain }).valid).toBe(true);
      }
    );
  });

  describe('dbName', () => {
    it.each(['wp`;DROP', 'wp db', 'wp-db', 'wp;drop', ''])(
      'rejects unsafe db name %j',
      (dbName) => {
        expect(validation.validateSiteInput({ ...base, dbName }).valid).toBe(false);
      }
    );

    it('accepts an underscore identifier', () => {
      expect(validation.validateSiteInput({ ...base, dbName: 'wp_db_1' }).valid).toBe(
        true
      );
    });
  });

  describe('path', () => {
    it('rejects a relative path', () => {
      expect(validation.validateSiteInput({ ...base, path: 'relative/dir' }).valid).toBe(
        false
      );
    });

    it('rejects a path with a newline', () => {
      expect(
        validation.validateSiteInput({ ...base, path: '/abs/with\nnewline' }).valid
      ).toBe(false);
    });
  });

  describe('phpVersion', () => {
    it.each(['8', '8.2.1', '8.2; echo', 'latest'])(
      'rejects invalid version %j',
      (phpVersion) => {
        expect(validation.validateSiteInput({ ...base, phpVersion }).valid).toBe(false);
      }
    );

    it('accepts a MAJOR.MINOR version', () => {
      expect(validation.validateSiteInput({ ...base, phpVersion: '7.4' }).valid).toBe(
        true
      );
    });
  });

  it('rejects an invalid admin email', () => {
    expect(
      validation.validateSiteInput({ ...base, adminEmail: 'not-an-email' }).valid
    ).toBe(false);
  });
});
