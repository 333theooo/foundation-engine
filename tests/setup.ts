import { config } from 'dotenv';

/**
 * Test environment.
 *
 * Loads `.env`, then overrides the pieces that must differ under test:
 * a separate database (so a test run cannot destroy development data) and a
 * forced mock AI provider (so no test can make a paid API call, even if a key
 * happens to be present in the environment).
 */
config({ path: '.env', quiet: true });

// `process.env.NODE_ENV` is typed read-only by the Next.js types, so the whole
// block is assigned through an index signature.
const env = process.env as Record<string, string | undefined>;

env.NODE_ENV = 'test';
env.AI_PROVIDER = 'mock';
env.AUTH_SECRET ??= 'test-secret-that-is-long-enough-for-validation';
env.STORAGE_DRIVER = 'local';
env.LOCAL_STORAGE_DIR = './storage/test';
env.LOG_LEVEL = 'error';

const base = env.DATABASE_URL ?? 'postgresql://atrium:atrium@localhost:5432/atrium?schema=public';
env.DATABASE_URL = env.TEST_DATABASE_URL ?? base.replace(/\/atrium(\?|$)/, '/atrium_test$1');
