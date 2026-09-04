import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with scrypt.
 *
 * scrypt is memory-hard, it ships in Node's standard library, and it has no
 * native build step — which matters because a native bcrypt/argon2 binding is a
 * common cause of "works on my machine" deployment failures. The parameters
 * below target roughly 100 ms per hash on a modern server; raise `N` as
 * hardware improves.
 *
 * The stored format is self-describing (`scrypt$N$r$p$salt$hash`) so parameters
 * can be increased later and old hashes still verify.
 */

/**
 * `promisify(scrypt)` resolves to the three-argument overload, which drops the
 * cost parameters, so the promise wrapper is written out explicitly.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

const N = 2 ** 15; // CPU/memory cost
const r = 8; // block size
const p = 1; // parallelism
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r,
    p,
    maxmem: 256 * 1024 * 1024,
  });
  return ['scrypt', N, r, p, salt.toString('base64'), derived.toString('base64')].join('$');
}

/**
 * Verifies a password. Returns false for malformed hashes rather than throwing,
 * so a corrupt row cannot become a 500 on the sign-in path.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelism = Number(parts[3]);
  if (
    !Number.isSafeInteger(cost) ||
    !Number.isSafeInteger(blockSize) ||
    !Number.isSafeInteger(parallelism)
  ) {
    return false;
  }

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64');
    expected = Buffer.from(parts[5]!, 'base64');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  try {
    const derived = await scryptAsync(password.normalize('NFKC'), salt, expected.length, {
      N: cost,
      r: blockSize,
      p: parallelism,
      maxmem: 256 * 1024 * 1024,
    });
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Minimum password policy. Deliberately length-first rather than symbol soup. */
export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 10) problems.push('Use at least 10 characters.');
  if (password.length > 256) problems.push('Use at most 256 characters.');
  if (/^\s|\s$/.test(password)) problems.push('Remove leading or trailing whitespace.');
  const common = ['password123', 'letmein123', '1234567890', 'qwertyuiop'];
  if (common.includes(password.toLowerCase())) problems.push('That password is too common.');
  return problems;
}
