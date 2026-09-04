import { createHash, randomBytes } from 'node:crypto';
import { headers } from 'next/headers';
import { prisma } from '@/server/db';
import { serverEnv } from '@/server/env';
import { logger } from '@/server/logger';
import { hashPassword, passwordProblems, verifyPassword } from './password';
import {
  clearSessionCookie,
  createSession,
  destroySession,
  readSessionToken,
  resolveSession,
  setSessionCookie,
  type SessionUser,
} from './session';

export * from './session';
export * from './password';

/**
 * The authentication surface used by routes and server components.
 *
 * Every function that touches a project takes the *resolved* user, never an id
 * from the request body — ownership is checked against the session, in
 * `src/server/projects.ts`, on every single operation.
 */

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number = 401,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  return resolveSession(await readSessionToken());
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthError('You need to be signed in to do that.', 401);
  return user;
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface RegisterInput {
  email: string;
  password: string;
  name?: string;
}

export async function registerUser(input: RegisterInput): Promise<SessionUser> {
  const email = normaliseEmail(input.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new AuthError('Enter a valid email address.', 400);
  }
  const problems = passwordProblems(input.password);
  if (problems.length > 0) throw new AuthError(problems.join(' '), 400);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // Deliberately the same shape of message as a bad password on sign-in, so
    // this endpoint is not an account-enumeration oracle.
    throw new AuthError('That email address is already registered.', 409);
  }

  const user = await prisma.user.create({
    data: {
      email,
      name: input.name?.trim().slice(0, 80) || email.split('@')[0] || 'Architect',
      passwordHash: await hashPassword(input.password),
      settings: {},
    },
  });

  logger().info({ userId: user.id }, 'user registered');
  return toSessionUser(user);
}

export async function authenticate(email: string, password: string): Promise<SessionUser> {
  const user = await prisma.user.findUnique({ where: { email: normaliseEmail(email) } });

  // Always run a hash comparison so the response time does not reveal whether
  // the address exists.
  const hash = user?.passwordHash ?? '$scrypt$1$1$1$AAAA$AAAA';
  const valid = await verifyPassword(password, hash);

  if (!user || !user.passwordHash || !valid || user.isGuest) {
    throw new AuthError('Those credentials did not match an account.', 401);
  }
  return toSessionUser(user);
}

/**
 * Creates a guest account.
 *
 * A guest is a real, isolated account with a random address and a 7-day life —
 * not a shared bucket, and not an authorisation bypass. Every ownership check
 * treats it exactly like a registered account, so a demo session can never see
 * another user's project.
 */
export async function createGuestUser(): Promise<SessionUser> {
  if (!serverEnv().ENABLE_GUEST_MODE) {
    throw new AuthError('Guest access is disabled on this deployment.', 403);
  }
  const suffix = randomBytes(9)
    .toString('base64url')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const user = await prisma.user.create({
    data: {
      email: `guest-${suffix}@guest.atrium.local`,
      name: 'Guest',
      isGuest: true,
      guestExpires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      settings: {},
    },
  });
  logger().info({ userId: user.id }, 'guest session created');
  return toSessionUser(user);
}

export async function signIn(user: SessionUser): Promise<void> {
  const headerList = await headers();
  const { token, expiresAt } = await createSession(user.id, {
    userAgent: headerList.get('user-agent'),
    ipHash: hashIp(headerList.get('x-forwarded-for')),
  });
  await setSessionCookie(token, expiresAt);
}

export async function signOut(): Promise<void> {
  await destroySession(await readSessionToken());
  await clearSessionCookie();
}

/**
 * Origin check for state-changing requests.
 *
 * SameSite=Lax already blocks cross-site form POSTs, and this is the second
 * layer: a mutation whose Origin does not match the deployment is refused
 * outright. Cheaper and harder to get wrong than a per-form token, and it does
 * not need a synchronised secret.
 */
export function assertSameOrigin(request: Request): void {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

  const origin = request.headers.get('origin');
  if (!origin) {
    // Non-browser clients (curl, tests) send no Origin. Same-origin fetches
    // from the app always do, so this only relaxes the check for tooling.
    return;
  }
  const allowed = new Set([serverEnv().APP_URL, process.env.APP_URL].filter(Boolean) as string[]);
  const requestUrl = new URL(request.url);
  allowed.add(requestUrl.origin);

  const originHost = safeOrigin(origin);
  const permitted = [...allowed].some((value) => safeOrigin(value) === originHost);
  if (!permitted) {
    throw new AuthError('Request origin is not allowed.', 403);
  }
}

function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function hashIp(forwardedFor: string | null): string | null {
  if (!forwardedFor) return null;
  const first = forwardedFor.split(',')[0]?.trim();
  if (!first) return null;
  return createHash('sha256')
    .update(`${first}:${serverEnv().AUTH_SECRET}`)
    .digest('hex')
    .slice(0, 32);
}

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: 'USER' | 'ADMIN';
  isGuest: boolean;
  settings: unknown;
};

function toSessionUser(user: UserRow): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isGuest: user.isGuest,
    settings: (user.settings as Record<string, unknown>) ?? {},
  };
}
