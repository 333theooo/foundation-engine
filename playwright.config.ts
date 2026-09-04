import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Resolves a Chromium executable.
 *
 * Playwright normally manages its own browser download. Some container images
 * ship a Chromium build under `PLAYWRIGHT_BROWSERS_PATH` that does not match the
 * revision this Playwright version expects, and re-downloading is either
 * impossible or wasteful there. In that case we point at the build that is
 * present. With `PLAYWRIGHT_BROWSERS_PATH` unset — the normal case, including
 * CI after `playwright install` — nothing changes.
 */
function resolveChromium(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;

  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;

  const candidates = readdirSync(root)
    .filter((entry) => /^chromium-\d+$/.test(entry))
    .sort()
    .reverse()
    .map((entry) => join(root, entry, 'chrome-linux', 'chrome'))
    .filter((path) => existsSync(path));

  return candidates[0];
}

const chromiumPath = resolveChromium();

const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    launchOptions: {
      // WebGL in headless Chromium needs software rendering in a container.
      args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
      /**
       * See `resolveChromium` above.
       */
      ...(chromiumPath ? { executablePath: chromiumPath } : {}),
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  /**
   * The end-to-end run targets a production build against its own database, so
   * it exercises the same code path a deployment does — including the strict
   * CSP, which only applies outside development.
   */
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `node --env-file=.env.e2e node_modules/next/dist/bin/next start --port ${PORT}`,
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
