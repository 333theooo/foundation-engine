import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { serverEnv } from './env';

/**
 * Prisma client.
 *
 * Prisma 7 connects through a driver adapter rather than reading the URL from
 * the schema, so the connection string lives in exactly one place: the
 * validated environment. In development the instance is cached on `globalThis`
 * so Next's hot reload does not exhaust the connection pool.
 */

const globalForPrisma = globalThis as unknown as { atriumPrisma?: PrismaClient };

function createClient(): PrismaClient {
  const env = serverEnv();
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  return new PrismaClient({
    adapter,
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

export const prisma: PrismaClient = globalForPrisma.atriumPrisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.atriumPrisma = prisma;
}

/** Cheap liveness probe used by /api/health. */
export async function databaseReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
