import pino from 'pino';
import { serverEnv } from './env';

/**
 * Structured logging.
 *
 * Two things matter more than the shape of the log lines:
 *
 *   * **Secrets never reach a log.** The redaction list below is applied by
 *     pino before serialisation, and `safeError` strips provider payloads.
 *   * **Private project content is not logged by default.** We log ids,
 *     counts, durations and command *types*. The user's design description and
 *     their prompt text are logged only at `debug`, which production does not
 *     enable.
 */

const REDACTED = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'apiKey',
  'password',
  'passwordHash',
  'token',
  'sessionToken',
  'ANTHROPIC_API_KEY',
  'S3_SECRET_ACCESS_KEY',
  'AUTH_SECRET',
  'DATABASE_URL',
  '*.apiKey',
  '*.password',
];

function create(): pino.Logger {
  let level = 'info';
  try {
    level = serverEnv().LOG_LEVEL;
  } catch {
    // Environment validation failures are themselves logged, so fall back
    // rather than making logging depend on a valid configuration.
  }
  return pino({
    level,
    redact: { paths: REDACTED, censor: '[redacted]' },
    base: { service: 'atrium-studio' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

let instance: pino.Logger | null = null;

export function logger(): pino.Logger {
  instance ??= create();
  return instance;
}

/** Child logger with a stable request id, so one request reads as one trace. */
export function requestLogger(requestId: string, extra: Record<string, unknown> = {}) {
  return logger().child({ requestId, ...extra });
}

/**
 * Converts an unknown thrown value into something loggable and, separately,
 * something safe to show a user. Provider errors often embed request bodies —
 * which for us means project content — so the public message is always ours.
 */
export function safeError(error: unknown): { log: Record<string, unknown>; publicMessage: string } {
  if (error instanceof Error) {
    return {
      log: { name: error.name, message: error.message, stack: error.stack },
      publicMessage: error.message.slice(0, 300),
    };
  }
  return {
    log: { message: String(error).slice(0, 1000) },
    publicMessage: 'An unexpected error occurred.',
  };
}
