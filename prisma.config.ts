import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 moved the connection URL out of `schema.prisma` and into a driver
 * adapter, so this file is where migrations and the CLI learn how to reach the
 * database. The application client is constructed in `src/server/db.ts` with the
 * same adapter.
 */
export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
