import { afterAll, describe, expect, it } from 'vitest';
import { AuthError, authenticate, registerUser } from '@/server/auth';
import { createSession, destroySession, pruneExpired, resolveSession } from '@/server/auth/session';
import { consumeRateLimit } from '@/server/rateLimit';
import { disconnectTestDb, testDb } from './helpers';

afterAll(async () => {
  await disconnectTestDb();
});

function uniqueEmail(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 10)}@test.local`;
}

describe('registration and sign-in', () => {
  it('registers an account and signs it in', async () => {
    const email = uniqueEmail('register');
    const user = await registerUser({ email, password: 'a-good-long-passphrase', name: 'Ada' });
    expect(user.email).toBe(email);
    expect(user.name).toBe('Ada');

    const signedIn = await authenticate(email, 'a-good-long-passphrase');
    expect(signedIn.id).toBe(user.id);
  });

  it('normalises the email address', async () => {
    const email = uniqueEmail('CaseTest').toUpperCase();
    const user = await registerUser({ email, password: 'a-good-long-passphrase' });
    expect(user.email).toBe(email.toLowerCase());
    await expect(authenticate(email.toLowerCase(), 'a-good-long-passphrase')).resolves.toBeTruthy();
  });

  it('rejects a duplicate registration', async () => {
    const email = uniqueEmail('duplicate');
    await registerUser({ email, password: 'a-good-long-passphrase' });
    await expect(registerUser({ email, password: 'another-long-passphrase' })).rejects.toThrow(
      AuthError,
    );
  });

  it('rejects a weak password before it reaches the database', async () => {
    const email = uniqueEmail('weak');
    await expect(registerUser({ email, password: 'short' })).rejects.toThrow(/at least 10/);
    expect(await testDb().user.count({ where: { email } })).toBe(0);
  });

  it('rejects a malformed email address', async () => {
    await expect(
      registerUser({ email: 'not-an-email', password: 'a-good-long-passphrase' }),
    ).rejects.toThrow(/valid email/);
  });

  it('rejects the wrong password', async () => {
    const email = uniqueEmail('wrong-password');
    await registerUser({ email, password: 'a-good-long-passphrase' });
    await expect(authenticate(email, 'not-the-password')).rejects.toThrow(AuthError);
  });

  it('gives an unknown account the same error as a wrong password', async () => {
    const unknown = await authenticate(uniqueEmail('nobody'), 'anything').catch((error) => error);
    const email = uniqueEmail('known');
    await registerUser({ email, password: 'a-good-long-passphrase' });
    const wrong = await authenticate(email, 'wrong-password').catch((error) => error);
    expect((unknown as AuthError).message).toBe((wrong as AuthError).message);
    expect((unknown as AuthError).status).toBe((wrong as AuthError).status);
  });

  it('refuses to sign in a guest account with a password', async () => {
    const guest = await testDb().user.create({
      data: { email: uniqueEmail('guest'), name: 'Guest', isGuest: true, settings: {} },
    });
    await expect(authenticate(guest.email, 'anything')).rejects.toThrow(AuthError);
  });
});

describe('sessions', () => {
  it('issues a token that resolves to the user', async () => {
    const user = await registerUser({
      email: uniqueEmail('session'),
      password: 'a-good-long-passphrase',
    });
    const { token } = await createSession(user.id);
    const resolved = await resolveSession(token);
    expect(resolved?.id).toBe(user.id);
  });

  it('stores only a hash of the token', async () => {
    const user = await registerUser({
      email: uniqueEmail('hashed'),
      password: 'a-good-long-passphrase',
    });
    const { token } = await createSession(user.id);
    const rows = await testDb().session.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(token);
    expect(rows[0]!.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects an unknown or absent token', async () => {
    expect(await resolveSession(undefined)).toBeNull();
    expect(await resolveSession('not-a-real-token')).toBeNull();
  });

  it('rejects and cleans up an expired session', async () => {
    const user = await registerUser({
      email: uniqueEmail('expired'),
      password: 'a-good-long-passphrase',
    });
    const { token } = await createSession(user.id);
    await testDb().session.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect(await resolveSession(token)).toBeNull();
    expect(await testDb().session.count({ where: { userId: user.id } })).toBe(0);
  });

  it('rejects a lapsed guest session', async () => {
    const guest = await testDb().user.create({
      data: {
        email: uniqueEmail('lapsed'),
        name: 'Guest',
        isGuest: true,
        guestExpires: new Date(Date.now() - 1000),
        settings: {},
      },
    });
    const { token } = await createSession(guest.id);
    expect(await resolveSession(token)).toBeNull();
  });

  it('destroys a session on sign out', async () => {
    const user = await registerUser({
      email: uniqueEmail('signout'),
      password: 'a-good-long-passphrase',
    });
    const { token } = await createSession(user.id);
    await destroySession(token);
    expect(await resolveSession(token)).toBeNull();
  });

  it('prunes expired sessions and lapsed guests', async () => {
    const guest = await testDb().user.create({
      data: {
        email: uniqueEmail('prune'),
        name: 'Guest',
        isGuest: true,
        guestExpires: new Date(Date.now() - 1000),
        settings: {},
      },
    });
    await createSession(guest.id);
    await testDb().session.updateMany({
      where: { userId: guest.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const pruned = await pruneExpired();
    expect(pruned.sessions).toBeGreaterThanOrEqual(1);
    expect(pruned.guests).toBeGreaterThanOrEqual(1);
    expect(await testDb().user.count({ where: { id: guest.id } })).toBe(0);
  });

  it('deletes sessions with the account', async () => {
    const user = await registerUser({
      email: uniqueEmail('cascade'),
      password: 'a-good-long-passphrase',
    });
    await createSession(user.id);
    await testDb().user.delete({ where: { id: user.id } });
    expect(await testDb().session.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe('rate limiting', () => {
  it('allows requests up to the limit and then refuses', async () => {
    const subject = `test-${Math.random().toString(36).slice(2)}`;
    let allowed = 0;
    let blocked = 0;

    // The auth bucket default is 30 per hour.
    for (let i = 0; i < 35; i += 1) {
      const result = await consumeRateLimit('auth', subject);
      if (result.allowed) allowed += 1;
      else blocked += 1;
    }

    expect(allowed).toBe(30);
    expect(blocked).toBe(5);
  });

  it('keeps buckets and subjects independent', async () => {
    const subject = `isolated-${Math.random().toString(36).slice(2)}`;
    for (let i = 0; i < 30; i += 1) await consumeRateLimit('auth', subject);

    expect((await consumeRateLimit('auth', subject)).allowed).toBe(false);
    // A different bucket for the same subject is unaffected.
    expect((await consumeRateLimit('ai', subject)).allowed).toBe(true);
    // A different subject in the same bucket is unaffected.
    expect((await consumeRateLimit('auth', `${subject}-other`)).allowed).toBe(true);
  });

  it('does not record a hit for a blocked request', async () => {
    const subject = `no-extend-${Math.random().toString(36).slice(2)}`;
    for (let i = 0; i < 30; i += 1) await consumeRateLimit('auth', subject);
    const before = await testDb().rateLimitHit.count({ where: { bucket: `auth:${subject}` } });
    await consumeRateLimit('auth', subject);
    const after = await testDb().rateLimitHit.count({ where: { bucket: `auth:${subject}` } });
    expect(after).toBe(before);
  });
});
