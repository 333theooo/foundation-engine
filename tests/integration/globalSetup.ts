import { execFileSync } from 'node:child_process';
import { config } from 'dotenv';

/**
 * Prepares the test database before any integration test runs.
 *
 * `prisma migrate deploy` is idempotent, so this is safe to run on every
 * invocation and guarantees the schema matches the migrations in the repo
 * rather than whatever a previous run happened to leave behind.
 */
export default function globalSetup(): void {
  config({ path: '.env', quiet: true });

  const base =
    process.env.DATABASE_URL ?? 'postgresql://atrium:atrium@localhost:5432/atrium?schema=public';
  const testUrl = process.env.TEST_DATABASE_URL ?? base.replace(/\/atrium(\?|$)/, '/atrium_test$1');

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'inherit',
  });
}
