import { describe, expect, it } from 'vitest';
import { hashPassword, passwordProblems, verifyPassword } from '@/server/auth/password';
import {
  ALLOWED_DOCUMENT_EXTENSIONS,
  ALLOWED_MODEL_EXTENSIONS,
  assertSafeKey,
  createStorageKey,
  displayFilename,
  extensionOf,
} from '@/server/storage';

describe('password hashing', () => {
  it('produces a self-describing hash that verifies', async () => {
    const hash = await hashPassword('a-reasonable-password');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('a-reasonable-password', hash)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('a-reasonable-password');
    expect(await verifyPassword('a-reasonable-passwerd', hash)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('same-password-twice');
    const b = await hashPassword('same-password-twice');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password-twice', a)).toBe(true);
    expect(await verifyPassword('same-password-twice', b)).toBe(true);
  });

  it('normalises unicode so an equivalent password still verifies', async () => {
    // Composed vs decomposed "é".
    const hash = await hashPassword('caf\u00e9-passphrase');
    expect(await verifyPassword('cafe\u0301-passphrase', hash)).toBe(true);
  });

  it('returns false rather than throwing on a malformed stored hash', async () => {
    for (const stored of ['', 'nonsense', 'scrypt$1$1', 'bcrypt$a$b$c$d$e', 'scrypt$x$y$z$a$b']) {
      expect(await verifyPassword('anything', stored)).toBe(false);
    }
  });

  it('enforces a length-first password policy', () => {
    expect(passwordProblems('short')).toContain('Use at least 10 characters.');
    expect(passwordProblems('password123')).toContain('That password is too common.');
    expect(passwordProblems(' leadingspace123 ')).toContain(
      'Remove leading or trailing whitespace.',
    );
    expect(passwordProblems('a-perfectly-fine-passphrase')).toEqual([]);
  });
});

describe('storage keys', () => {
  it('generates a key that never contains the user filename', () => {
    const key = createStorageKey('imports', 'user_abc123', 'ifc');
    expect(key).toMatch(/^imports\/userabc123\/[0-9a-f]{32}\.ifc$/);
  });

  it('generates a distinct key every time', () => {
    const keys = new Set(Array.from({ length: 50 }, () => createStorageKey('imports', 'u', 'glb')));
    expect(keys.size).toBe(50);
  });

  it('strips anything unsafe out of the namespace and extension', () => {
    const key = createStorageKey('../../etc', 'user/../root', 'ifc;rm -rf');
    expect(key).not.toContain('..');
    expect(key).not.toContain(';');
    expect(() => assertSafeKey(key)).not.toThrow();
  });

  it('refuses traversal and absolute paths', () => {
    for (const key of [
      '../secrets',
      'imports/../../etc/passwd',
      '/etc/passwd',
      'imports/user/../../../root',
      'Imports/User/File',
      'imports/user/file with spaces',
    ]) {
      expect(() => assertSafeKey(key)).toThrow();
    }
  });

  it('accepts a well-formed key', () => {
    expect(() => assertSafeKey('imports/user123/abcdef0123456789.glb')).not.toThrow();
  });

  it('reads extensions case-insensitively', () => {
    expect(extensionOf('Model.IFC')).toBe('ifc');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('no-extension')).toBe('');
  });

  it('sanitises a display filename', () => {
    expect(displayFilename('../../etc/passwd')).toBe('passwd');
    expect(displayFilename('C:\\Users\\me\\plan.ifc')).toBe('plan.ifc');
    expect(displayFilename('bad\u0000name.ifc')).toBe('badname.ifc');
    expect(displayFilename('')).toBe('upload');
  });

  it('keeps the upload allowlists tight', () => {
    expect(ALLOWED_MODEL_EXTENSIONS).not.toContain('exe');
    expect(ALLOWED_MODEL_EXTENSIONS).not.toContain('js');
    expect(ALLOWED_MODEL_EXTENSIONS).not.toContain('html');
    expect(ALLOWED_DOCUMENT_EXTENSIONS).not.toContain('pdf');
    expect(ALLOWED_DOCUMENT_EXTENSIONS).not.toContain('html');
  });
});

describe('no dynamic code execution', () => {
  it('has no eval or Function constructor anywhere in the source', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    async function walk(directory: string): Promise<string[]> {
      const entries = await readdir(directory, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        if (entry.name === 'generated' || entry.name === 'node_modules') continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) files.push(...(await walk(path)));
        else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path);
      }
      return files;
    }

    const files = await walk('src');
    expect(files.length).toBeGreaterThan(30);

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      // Match calls, not the word inside prose or a rule name.
      expect(source).not.toMatch(/(^|[^\w.])eval\s*\(/);
      expect(source).not.toMatch(/new\s+Function\s*\(/);
    }
  });
});
