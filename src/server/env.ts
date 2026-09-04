import { z } from 'zod';

/**
 * Environment validation.
 *
 * Parsed once, at import time, so a misconfigured deployment fails at boot with
 * a readable list of problems instead of throwing somewhere deep in a request
 * six hours later.
 *
 * Two rules this file enforces:
 *   1. **Nothing secret is ever exported to the client.** Only `NEXT_PUBLIC_*`
 *      values may cross that line, and none of them are secrets.
 *   2. **Development has working defaults; production does not.** Anything that
 *      would be unsafe with a default (session secret, database URL) is required
 *      in production and only auto-filled for local work.
 */

const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()),
  );

const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required. See .env.example.')
    .refine((value) => value.startsWith('postgres://') || value.startsWith('postgresql://'), {
      message: 'DATABASE_URL must be a PostgreSQL connection string.',
    }),

  /** Signs session cookies. Must be at least 32 characters in production. */
  AUTH_SECRET: isProduction
    ? z.string().min(32, 'AUTH_SECRET must be at least 32 characters in production.')
    : z.string().min(8).default('dev-only-insecure-secret-change-me'),

  /** Absolute origin, used for cookie scoping and absolute URLs. */
  APP_URL: z.string().url().default('http://localhost:3000'),

  /**
   * Anthropic credentials. Optional by design: without a key the application
   * runs the deterministic local interpreter (`AI_PROVIDER=mock`) so every
   * other feature stays testable. See docs/ai.md.
   */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),
  AI_PROVIDER: z.enum(['anthropic', 'mock', 'auto']).default('auto'),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(64_000).default(8_000),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(120_000),

  /** Object storage. Falls back to the local filesystem when unset. */
  STORAGE_DRIVER: z.enum(['s3', 'local']).default('local'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: booleanish.default(true),
  LOCAL_STORAGE_DIR: z.string().default('./storage'),

  RATE_LIMIT_AI_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(120),
  RATE_LIMIT_UPLOAD_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(60),
  RATE_LIMIT_AUTH_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(30),

  /** Allows the unauthenticated demo project. Never weakens account isolation. */
  ENABLE_GUEST_MODE: booleanish.default(true),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type ServerEnv = z.infer<typeof serverSchema>;

function loadEnv(): ServerEnv {
  const source: Record<string, unknown> = { ...process.env };

  // Tests and local development get a working database URL without ceremony.
  if (!source.DATABASE_URL && (isTest || !isProduction)) {
    source.DATABASE_URL = 'postgresql://atrium:atrium@localhost:5432/atrium?schema=public';
  }

  const parsed = serverSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${details}\n\nCopy .env.example to .env and fill in the required values.`,
    );
  }

  const env = parsed.data;

  if (env.STORAGE_DRIVER === 's3') {
    const missing = (['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const).filter(
      (key) => !env[key],
    );
    if (missing.length > 0) {
      throw new Error(
        `STORAGE_DRIVER=s3 requires ${missing.join(', ')}. Set them, or use STORAGE_DRIVER=local for development.`,
      );
    }
  }

  return env;
}

let cached: ServerEnv | null = null;

/** Validated server environment. Never import this from a client component. */
export function serverEnv(): ServerEnv {
  cached ??= loadEnv();
  return cached;
}

/** Which AI provider will actually be used, after resolving `auto`. */
export function resolvedAiProvider(): 'anthropic' | 'mock' {
  const env = serverEnv();
  if (env.AI_PROVIDER === 'anthropic') return 'anthropic';
  if (env.AI_PROVIDER === 'mock') return 'mock';
  return env.ANTHROPIC_API_KEY ? 'anthropic' : 'mock';
}

export function isProductionEnv(): boolean {
  return serverEnv().NODE_ENV === 'production';
}
