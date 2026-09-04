import { NextResponse } from 'next/server';
import { databaseReachable } from '@/server/db';
import { resolvedAiProvider, serverEnv } from '@/server/env';
import { pruneExpired } from '@/server/auth/session';

export const dynamic = 'force-dynamic';

/**
 * Health check.
 *
 * Reports what a load balancer needs (is this instance serving?) and what an
 * operator needs (which AI provider and storage driver are actually active).
 * It also takes the opportunity to prune expired sessions and lapsed guest
 * accounts, so the deployment needs no separate cron for housekeeping.
 */
export async function GET() {
  const startedAt = Date.now();
  const database = await databaseReachable();

  let pruned = { sessions: 0, guests: 0 };
  if (database && Math.random() < 0.1) {
    pruned = await pruneExpired().catch(() => ({ sessions: 0, guests: 0 }));
  }

  const env = serverEnv();
  const body = {
    status: database ? 'ok' : 'degraded',
    version: process.env.npm_package_version ?? '0.1.0',
    checks: {
      database: database ? 'ok' : 'unreachable',
      aiProvider: resolvedAiProvider(),
      storage: env.STORAGE_DRIVER,
      guestMode: env.ENABLE_GUEST_MODE,
    },
    pruned,
    latencyMs: Date.now() - startedAt,
    time: new Date().toISOString(),
  };

  return NextResponse.json(body, { status: database ? 200 : 503 });
}
