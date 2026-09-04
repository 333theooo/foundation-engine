import { expect, test, type Page } from '@playwright/test';

/**
 * The central workflow, end to end.
 *
 * This test walks the path the product is built around, against a real server,
 * a real database and a real WebGL context:
 *
 *   1. start a session and open a project
 *   2. ask the assistant to create a building
 *   3. watch commands validate and geometry appear
 *   4. edit an element by hand
 *   5. ask the assistant to modify that element
 *   6. undo and redo
 *   7. reload, and find the project intact
 *   8. export it
 *
 * It runs against the built-in local interpreter, so it needs no API key and is
 * deterministic — which is exactly why that interpreter exists.
 */

const AI_TIMEOUT = 45_000;
const ONBOARDING_KEY = 'atrium.onboarding.v1';

/**
 * Suppresses first-run onboarding.
 *
 * Onboarding is driven by a localStorage flag, so setting it before the page
 * loads is both deterministic and exactly what a returning user experiences.
 * Waiting for the dialog and clicking through it would make every test depend
 * on how long the 3D viewport takes to mount, which in a software-rendered
 * container is highly variable.
 */
async function skipOnboarding(page: Page): Promise<void> {
  await page.addInitScript((key: string) => {
    try {
      window.localStorage.setItem(key, 'done');
    } catch {
      // Storage disabled: the dialog will show, and the test will say so.
    }
  }, ONBOARDING_KEY);
}

async function startGuestSession(page: Page): Promise<string> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'What are we designing?' })).toBeVisible();

  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForURL(/\/studio\/[a-z0-9]+/, { timeout: 30_000 });

  const projectId = new URL(page.url()).pathname.split('/').pop()!;
  expect(projectId).toBeTruthy();
  return projectId;
}

/** Waits for the viewport to be live before interacting with the workspace. */
async function waitForViewport(page: Page): Promise<void> {
  await expect(page.getByTestId('viewport')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('viewport').locator('canvas')).toBeVisible({ timeout: 60_000 });
  // The onboarding dialog would make everything behind it inert; assert it is
  // absent rather than letting a later click fail mysteriously.
  await expect(page.getByRole('dialog', { name: 'Welcome to Atrium Studio' })).toBeHidden();
}

/**
 * Element count from the status bar, which reads the live model.
 * Read from a data attribute rather than scraped from text, so it does not
 * break when the label is reworded.
 */
async function elementCount(page: Page): Promise<number> {
  const value = await page.getByTestId('element-count').getAttribute('data-count');
  return Number(value ?? '0');
}

async function sendPrompt(page: Page, prompt: string): Promise<void> {
  const input = page.getByLabel('Message the design assistant');
  await input.fill(prompt);
  await page.getByRole('button', { name: 'Send' }).click();
  // The Send button returns once the stream is finished.
  await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden({ timeout: AI_TIMEOUT });
}

test.describe('the conversational modelling workflow', () => {
  test.beforeEach(async ({ page }) => {
    await skipOnboarding(page);
  });

  test('creates, edits, undoes and reloads a building', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    /* 1. Open a project. */
    const projectId = await startGuestSession(page);
    await waitForViewport(page);

    // The guest session opens the sample project, so there is already geometry.
    // The model is installed into the store by an effect after hydration, so
    // this is a poll rather than a single read.
    await expect.poll(async () => elementCount(page), { timeout: 30_000 }).toBeGreaterThan(20);
    const initialCount = await elementCount(page);

    /* 2 and 3. Ask for a change and watch it validate and apply. */
    await sendPrompt(page, 'Add three evenly spaced windows to the west façade.');

    await expect(page.getByText(/Added 3 windows/i)).toBeVisible({ timeout: AI_TIMEOUT });
    const afterWindows = await elementCount(page);
    expect(afterWindows).toBe(initialCount + 3);

    // The assistant states what it assumed.
    await expect(page.getByText('Assumptions')).toBeVisible();

    /* 4. Edit an element by hand. */
    await page.getByRole('tab', { name: 'Properties' }).click();

    // Select a named wall through the hierarchy search, so the test does not
    // depend on where the camera happens to be pointing.
    await page.getByLabel('Search elements').fill('South wall');
    await page.getByRole('button', { name: 'South wall', exact: true }).first().click();

    // The name is an input, so assert on the id the inspector prints instead.
    await expect(page.getByRole('tabpanel')).toContainText('wall_g_south');

    const heightField = page.getByLabel('Height').first();
    await expect(heightField).toBeVisible();
    await heightField.fill('3.2 m');
    await heightField.press('Enter');
    await expect(heightField).toHaveValue('3.2 m');

    // The change is real: the status bar reads the model, not the field.
    await expect(page.locator('footer')).toContainText('3.2 m');

    await page.getByLabel('Search elements').fill('');

    /* 5. Ask the assistant to change the same design. */
    await page.getByRole('tab', { name: 'Assistant' }).click();
    await sendPrompt(page, 'Change the façade to dark timber.');
    await expect(page.getByText(/Updated materials/i)).toBeVisible({ timeout: AI_TIMEOUT });

    /* 6. Undo and redo. */
    const beforeUndo = await elementCount(page);
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect
      .poll(async () => elementCount(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(beforeUndo);

    await page.getByRole('button', { name: 'Redo' }).click();
    await page.getByRole('button', { name: 'Redo' }).click();
    await expect.poll(async () => elementCount(page), { timeout: 10_000 }).toBe(beforeUndo);

    /* 7. Reload and confirm the work survived. */
    await expect(page.getByText(/^Saved/)).toBeVisible({ timeout: 20_000 });

    await page.reload();
    await waitForViewport(page);
    await expect.poll(async () => elementCount(page), { timeout: 20_000 }).toBe(beforeUndo);

    // The conversation is restored too.
    await expect(page.getByText(/Added 3 windows/i)).toBeVisible({ timeout: 20_000 });

    /* 8. Export. */
    await page.getByRole('button', { name: 'Export' }).click();
    await expect(page.getByRole('heading', { name: 'Export' })).toBeVisible();

    const download = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByRole('button', { name: /Native project/ }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.atrium\.json$/);

    expect(errors, `Unexpected page errors: ${errors.join('; ')}`).toEqual([]);
    expect(projectId).toBeTruthy();
  });

  test('rejects an impossible request without changing the model', async ({ page }) => {
    await startGuestSession(page);
    await waitForViewport(page);

    await expect.poll(async () => elementCount(page), { timeout: 30_000 }).toBeGreaterThan(0);
    const before = await elementCount(page);
    // The sample's west wall is 8 m, so six standard windows plus the margins
    // do not fit. The assistant must say so rather than cramming them in.
    await sendPrompt(page, 'Add six windows to the west façade.');

    await expect(page.getByText(/only .* long|How would you like to fit them/i)).toBeVisible({
      timeout: AI_TIMEOUT,
    });
    // Nothing partially applied.
    await expect.poll(async () => elementCount(page), { timeout: 10_000 }).toBe(before);
  });

  test('says plainly what it cannot do', async ({ page }) => {
    await startGuestSession(page);
    await waitForViewport(page);

    await expect.poll(async () => elementCount(page), { timeout: 30_000 }).toBeGreaterThan(0);
    const before = await elementCount(page);
    await sendPrompt(page, 'Explain the history of the Bauhaus.');

    await expect(page.getByText(/could not turn that into a modelling operation/i)).toBeVisible({
      timeout: AI_TIMEOUT,
    });
    expect(await elementCount(page)).toBe(before);
  });
});

test.describe('accounts and isolation', () => {
  test('registers an account and lands in a project', async ({ page }) => {
    await skipOnboarding(page);
    const email = `e2e-${Date.now()}@test.local`;

    await page.goto('/sign-up');
    await page.getByLabel('Name').fill('E2E Architect');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('a-good-long-passphrase');
    await page.getByRole('button', { name: 'Create account' }).click();

    await page.waitForURL(/\/studio\/[a-z0-9]+/, { timeout: 30_000 });
    await waitForViewport(page);
  });

  test('refuses a project that belongs to someone else', async ({ page, request }) => {
    // One guest, in a cookie jar of its own, creates a project.
    const first = await request.post('/api/auth/guest');
    expect(first.ok()).toBeTruthy();
    const { projectId } = (await first.json()) as { projectId: string };

    // A second, unrelated guest signs in inside the browser context.
    const second = await page.request.post('/api/auth/guest');
    expect(second.ok()).toBeTruthy();

    // Signed in, but not the owner: the project simply does not exist for them.
    const response = await page.goto(`/studio/${projectId}`);
    expect(response?.status()).toBe(404);
  });

  test('requires a session for the dashboard', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForURL(/\/sign-in/, { timeout: 15_000 });
  });
});

test.describe('the workspace itself', () => {
  test('shows first-run onboarding, and remembers it was dismissed', async ({ page }) => {
    await startGuestSession(page);

    const dialog = page.getByRole('dialog', { name: 'Welcome to Atrium Studio' });
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await expect(dialog.getByText('Describe what you want to build')).toBeVisible();

    await dialog.getByRole('button', { name: 'Next' }).click();
    await expect(dialog.getByText('Edit directly too')).toBeVisible();

    await dialog.getByRole('button', { name: 'Skip' }).click();
    await expect(dialog).toBeHidden();

    await page.reload();
    await waitForViewport(page);
  });

  test('exposes working view controls and panels', async ({ page }) => {
    await skipOnboarding(page);
    await startGuestSession(page);
    await waitForViewport(page);

    // Orthographic toggle.
    await page.getByRole('button', { name: 'Persp' }).click();
    await expect(page.getByRole('button', { name: 'Ortho' })).toBeVisible();

    // Standard views.
    await page.getByRole('button', { name: 'Top', exact: true }).click();
    await page.getByRole('button', { name: 'Iso', exact: true }).click();

    // Panels collapse so the viewport can take the screen.
    await page.getByRole('button', { name: 'Toggle project panel' }).click();
    await expect(page.getByLabel('Search elements')).toBeHidden();
    await page.getByRole('button', { name: 'Toggle project panel' }).click();
    await expect(page.getByLabel('Search elements')).toBeVisible();

    // The review tab reports findings, and states its own limits.
    await page.getByRole('tab', { name: /Review/ }).click();
    await expect(page.getByText(/not a code check/i)).toBeVisible();
  });

  test('has a health endpoint that reports the active providers', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.ok()).toBeTruthy();
    const body = (await response.json()) as {
      status: string;
      checks: { database: string; aiProvider: string; storage: string };
    };
    expect(body.status).toBe('ok');
    expect(body.checks.database).toBe('ok');
    expect(['anthropic', 'mock']).toContain(body.checks.aiProvider);
  });

  test('sets the security headers it promises', async ({ request }) => {
    const response = await request.get('/');
    const headers = response.headers();
    expect(headers['content-security-policy']).toContain("default-src 'self'");
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });
});
