import { prisma } from '@/server/db';
import { serverEnv } from '@/server/env';
import { logger } from '@/server/logger';

/**
 * Sliding-window rate limiting, backed by Postgres.
 *
 * Choosing the database over Redis is deliberate: it keeps the required
 * infrastructure to one service, and limits stay correct across multiple app
 * instances, which an in-memory counter would not. The volume is tiny (one row
 * per accepted request, pruned on write), so the cost is negligible next to the
 * AI call it is protecting.
 */

export type RateLimitBucket = 'ai' | 'upload' | 'auth';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  /** When the oldest hit in the window falls out, as an epoch millisecond. */
  resetAt: number;
}

const WINDOW_MS = 60 * 60 * 1000;

function limitFor(bucket: RateLimitBucket): number {
  const env = serverEnv();
  switch (bucket) {
    case 'ai':
      return env.RATE_LIMIT_AI_PER_HOUR;
    case 'upload':
      return env.RATE_LIMIT_UPLOAD_PER_HOUR;
    case 'auth':
      return env.RATE_LIMIT_AUTH_PER_HOUR;
  }
}

/**
 * Consumes one unit from `bucket` for `subject`. Records the hit only when the
 * request is allowed, so a client that is already blocked cannot extend its own
 * penalty window by hammering the endpoint.
 */
export async function consumeRateLimit(
  bucket: RateLimitBucket,
  subject: string,
): Promise<RateLimitResult> {
  const limit = limitFor(bucket);
  const key = `${bucket}:${subject}`;
  const since = new Date(Date.now() - WINDOW_MS);

  try {
    const [count, oldest] = await Promise.all([
      prisma.rateLimitHit.count({ where: { bucket: key, createdAt: { gte: since } } }),
      prisma.rateLimitHit.findFirst({
        where: { bucket: key, createdAt: { gte: since } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);

    const resetAt = (oldest?.createdAt.getTime() ?? Date.now()) + WINDOW_MS;
    if (count >= limit) {
      return { allowed: false, remaining: 0, limit, resetAt };
    }

    await prisma.rateLimitHit.create({ data: { bucket: key } });

    // Opportunistic pruning keeps the table bounded without a cron job.
    if (Math.random() < 0.02) {
      await prisma.rateLimitHit
        .deleteMany({ where: { createdAt: { lt: new Date(Date.now() - WINDOW_MS * 2) } } })
        .catch(() => undefined);
    }

    return { allowed: true, remaining: Math.max(0, limit - count - 1), limit, resetAt };
  } catch (error) {
    // A rate limiter that fails closed would take the whole app down with the
    // database; log loudly and allow, since the DB outage is the real incident.
    logger().error({ err: error, bucket }, 'rate limit check failed; allowing request');
    return { allowed: true, remaining: limit, limit, resetAt: Date.now() + WINDOW_MS };
  }
}
