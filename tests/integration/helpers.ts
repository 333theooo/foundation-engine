import { randomBytes } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import type { SessionUser } from '@/server/auth/session';

/**
 * Integration test helpers.
 *
 * These tests run against a real PostgreSQL database (`atrium_test`), because
 * the things worth testing here — ownership boundaries, transactional saves,
 * cascade deletes, unique constraints — are precisely the things an in-memory
 * fake would not reproduce.
 *
 * Every test creates its own user, so tests are independent and can run in any
 * order without a truncate step between them.
 */

let client: PrismaClient | null = null;

export function testDb(): PrismaClient {
  if (!client) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set for tests.');
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  }
  return client;
}

export async function disconnectTestDb(): Promise<void> {
  await client?.$disconnect();
  client = null;
}

/** Creates an isolated user and returns it in session-user shape. */
export async function makeUser(label = 'user'): Promise<SessionUser> {
  const suffix = randomBytes(8).toString('hex');
  const row = await testDb().user.create({
    data: {
      email: `${label}-${suffix}@test.local`,
      name: `Test ${label}`,
      passwordHash: null,
      settings: {},
    },
  });
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    isGuest: row.isGuest,
    settings: {},
  };
}

/** Removes a user and, by cascade, everything they own. */
export async function removeUser(user: SessionUser): Promise<void> {
  await testDb().user.deleteMany({ where: { id: user.id } });
}
