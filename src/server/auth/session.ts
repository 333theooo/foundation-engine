import { createHash, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { prisma } from '@/server/db';
import { serverEnv } from '@/server/env';

/**
 * Session management.
 *
 * Design: opaque random tokens stored server-side, never JWTs. A database
 * session can be revoked the instant a user signs out or an account is deleted,
 * which a stateless token cannot. Only the SHA-256 of the token is persisted,
 * so a database leak does not hand an attacker working sessions.
 *
 * The cookie is `HttpOnly`, `SameSite=Lax` (which blocks cross-site POSTs while
 * keeping ordinary navigation working) and `Secure` outside development.
 */

export const SESSION_COOKIE = 'atrium_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RENEW_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: 'USER' | 'ADMIN';
  isGuest: boolean;
  settings: Record<string, unknown>;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function createSession(
  userId: string,
  meta: { userAgent?: string | null; ipHash?: string | null } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({
    data: {
      id: hashToken(token),
      userId,
      expiresAt,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      ipHash: meta.ipHash ?? null,
    },
  });
  return { token, expiresAt };
}

/**
 * Resolves a raw token to a user, sliding the expiry when it is close to
 * lapsing. Expired sessions are deleted on read so the table self-prunes.
 */
export async function resolveSession(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const id = hashToken(token);
  const session = await prisma.session.findUnique({ where: { id }, include: { user: true } });
  if (!session) return null;

  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.session.delete({ where: { id } }).catch(() => undefined);
    return null;
  }

  if (session.expiresAt.getTime() - Date.now() < RENEW_WITHIN_MS) {
    await prisma.session
      .update({ where: { id }, data: { expiresAt: new Date(Date.now() + SESSION_TTL_MS) } })
      .catch(() => undefined);
  }

  const { user } = session;
  if (user.isGuest && user.guestExpires && user.guestExpires.getTime() < Date.now()) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isGuest: user.isGuest,
    settings: (user.settings as Record<string, unknown>) ?? {},
  };
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  await prisma.session.delete({ where: { id: hashToken(token) } }).catch(() => undefined);
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: serverEnv().NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: serverEnv().NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
}

export async function readSessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value;
}

/** Removes expired sessions and lapsed guest accounts. Called by /api/health. */
export async function pruneExpired(): Promise<{ sessions: number; guests: number }> {
  const sessions = await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  const guests = await prisma.user.deleteMany({
    where: { isGuest: true, guestExpires: { lt: new Date() } },
  });
  return { sessions: sessions.count, guests: guests.count };
}
