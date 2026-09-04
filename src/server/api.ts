import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthError, assertSameOrigin, getCurrentUser, requireUser } from '@/server/auth';
import type { SessionUser } from '@/server/auth/session';
import { ProjectAccessError } from '@/server/projects';
import { ProjectMigrationError } from '@/domain/project/migrations';
import { requestLogger, safeError } from '@/server/logger';
import { consumeRateLimit, type RateLimitBucket } from '@/server/rateLimit';

/**
 * Route plumbing.
 *
 * Every API route goes through `route()`, which is what makes the security
 * properties uniform rather than per-endpoint discipline:
 *
 *   * mutations get an Origin check before anything else runs;
 *   * `auth: 'required'` resolves the session and hands the handler a real user,
 *     so no handler ever reads an owner id out of a request body;
 *   * rate limits are keyed to the authenticated user, not to an IP header a
 *     client controls;
 *   * errors become a consistent JSON shape with a message safe to show, while
 *     the detail goes to the log with a request id tying the two together.
 */

export interface RouteContext<Params extends Record<string, string> = Record<string, string>> {
  request: Request;
  params: Params;
  user: SessionUser;
  requestId: string;
  log: ReturnType<typeof requestLogger>;
}

export interface RouteOptions {
  auth?: 'required' | 'optional' | 'none';
  rateLimit?: RateLimitBucket;
  /** Skips the Origin check. Only for endpoints that are safe cross-origin. */
  allowCrossOrigin?: boolean;
}

type Handler<Params extends Record<string, string>> = (
  context: RouteContext<Params>,
) => Promise<Response> | Response;

export function apiError(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

export function apiOk<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

/**
 * Wraps a route handler. Next 15+ passes route params as a promise, which is
 * why the second argument is awaited rather than destructured.
 */
export function route<Params extends Record<string, string> = Record<string, string>>(
  handler: Handler<Params>,
  options: RouteOptions = {},
) {
  return async (
    request: Request,
    context: { params: Promise<Params> } | undefined,
  ): Promise<Response> => {
    const requestId = randomUUID();
    const url = new URL(request.url);
    const log = requestLogger(requestId, { method: request.method, path: url.pathname });

    try {
      if (!options.allowCrossOrigin) assertSameOrigin(request);

      let user: SessionUser | null = null;
      if (options.auth === 'required' || options.auth === undefined) {
        user = await requireUser();
      } else if (options.auth === 'optional') {
        user = await getCurrentUser();
      }

      if (options.rateLimit) {
        const subject = user?.id ?? 'anonymous';
        const limit = await consumeRateLimit(options.rateLimit, subject);
        if (!limit.allowed) {
          return apiError(
            `Rate limit reached for this action (${limit.limit} per hour). Try again after ${new Date(limit.resetAt).toLocaleTimeString()}.`,
            429,
            { resetAt: limit.resetAt },
          );
        }
      }

      const params = ((await context?.params) ?? {}) as Params;
      return await handler({
        request,
        params,
        user:
          user ??
          ({
            id: '',
            email: '',
            name: '',
            role: 'USER',
            isGuest: true,
            settings: {},
          } as SessionUser),
        requestId,
        log,
      });
    } catch (error) {
      return mapError(error, log, requestId);
    }
  };
}

function mapError(
  error: unknown,
  log: ReturnType<typeof requestLogger>,
  requestId: string,
): Response {
  if (error instanceof AuthError) {
    return apiError(error.message, error.status);
  }
  if (error instanceof ProjectAccessError) {
    return apiError(error.message, error.status);
  }
  if (error instanceof ProjectMigrationError) {
    log.warn({ err: error.message }, 'project migration failed');
    return apiError(error.message, 422);
  }
  if (error instanceof z.ZodError) {
    return apiError('That request was not valid.', 400, {
      issues: error.issues.slice(0, 8).map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  if (error instanceof SyntaxError) {
    return apiError('Request body was not valid JSON.', 400);
  }

  const { log: logPayload } = safeError(error);
  log.error({ err: logPayload }, 'unhandled route error');
  // The public message is ours, never the thrown one: provider and database
  // errors regularly embed request payloads, which for us means project content.
  return apiError('Something went wrong on our side. The request was not applied.', 500, {
    requestId,
  });
}

/** Parses and validates a JSON body. */
export async function readJson<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  const raw: unknown = await request.json();
  return schema.parse(raw);
}
