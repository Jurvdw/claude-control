import { _electron as electron, type ElectronApplication, type Page, test as base, expect } from '@playwright/test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Drives the REAL packaged Electron app — shell, preload, backend child process
 * and embedded Postgres — not a browser pointed at a dev server. Everything
 * that broke in manual testing (socket rooms, the default channel never
 * loading, preload wiring) lives in that seam, so testing a bare browser would
 * have missed all of it.
 *
 * ISOLATION: `--user-data-dir` is a native Electron switch, so it needs no
 * change to main.cjs — and because the backend derives PG_DATA_DIR,
 * STORAGE_LOCAL_DIR and secrets.json from userData, a temp dir gives each run
 * its own database, uploads and encryption key. Your real workspace is never
 * touched.
 *
 * The backend PORT is hard-coded to 4000 in main.cjs (after the env spread, so
 * it cannot be overridden), which means the installed app must be CLOSED while
 * these run. The fixture fails loudly rather than silently attaching to it.
 */

// Prefer the freshly built app over whatever happens to be installed. The
// Electron shell (main.cjs, preload.cjs, updater.cjs) ships inside app.asar,
// which ONLY changes when a new build is installed — deploying server/web dist
// does not touch it. Testing the installed app therefore tests a stale shell:
// the first run of this suite found the installed asar had no preload.cjs at
// all, so the whole update/IPC layer was dead in the running app.
const BUILT = path.resolve(__dirname, '..', 'release', 'win-unpacked', 'Claude Control.exe');
const INSTALLED = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Claude Control', 'Claude Control.exe');
const APP_EXE = process.env.CC_APP_EXE ?? (existsSync(BUILT) ? BUILT : INSTALLED);

// First boot initialises a fresh Postgres cluster; that is genuinely slow.
const BOOT_TIMEOUT = 180_000;

interface Fixtures {
  app: ElectronApplication;
  page: Page;
}

/** Fail fast if something already owns a port the test instance needs. */
async function assertPortFree(port: number, what: string) {
  const net = await import('node:net');
  const inUse = await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    setTimeout(() => { socket.destroy(); resolve(false); }, 1500);
  });
  if (inUse) {
    throw new Error(
      `E2E ISOLATION FAILED — port ${port} (${what}) is already in use.\n` +
        `Close Claude Control before running the e2e suite: the test app would ` +
        `connect to the RUNNING instance's database and write into your real workspace.`,
    );
  }
}

export const test = base.extend<Fixtures>({
  app: async ({}, use) => {
    if (!existsSync(APP_EXE)) {
      throw new Error(`Packaged app not found at ${APP_EXE}. Build it (npm run dist) or set CC_APP_EXE.`);
    }

    // --user-data-dir isolates the Postgres DATA DIR, but DATABASE_URL points at
    // a FIXED port (54329). If another Postgres already holds that port — i.e.
    // the real app is running — the test instance cannot bind, silently
    // connects to the live cluster instead, and writes test accounts and
    // workspaces into the user's real database. That happened on this suite's
    // first run. Refuse to start rather than repeat it.
    await assertPortFree(54329, 'Postgres (embedded)');
    await assertPortFree(4000, 'backend');
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'cc-e2e-'));
    const app = await electron.launch({
      executablePath: APP_EXE,
      args: [`--user-data-dir=${userDataDir}`],
      env: { ...process.env, CC_E2E: '1' },
      timeout: BOOT_TIMEOUT,
    });

    // PROVE the isolation before any test touches data. The backend derives
    // PG_DATA_DIR from userData, so if the switch is ignored the app runs
    // against the REAL workspace database — which is exactly what happened on
    // the first run of this suite: test accounts and a test workspace ended up
    // in the live database. Fail loudly instead of quietly corrupting it.
    const actual = await app.evaluate(({ app: a }) => a.getPath('userData'));
    if (path.resolve(actual) !== path.resolve(userDataDir)) {
      await app.close().catch(() => {});
      throw new Error(
        `E2E ISOLATION FAILED — refusing to run.\n` +
          `  expected userData: ${userDataDir}\n` +
          `  actual userData:   ${actual}\n` +
          `Tests would have written into the real workspace database.`,
      );
    }

    await use(app);
    await app.close().catch(() => {});
    // Postgres holds files briefly after shutdown; losing a temp dir is not
    // worth failing a green run over.
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  },

  page: async ({ app }, use) => {
    const page = await app.firstWindow({ timeout: BOOT_TIMEOUT });
    // The shell shows loading.html until the backend answers, then swaps to the
    // app URL. Wait for the real UI, not the splash.
    await page.waitForURL(/localhost:4000/, { timeout: BOOT_TIMEOUT });
    await page.waitForLoadState('domcontentloaded');
    await use(page);
  },
});

export { expect };

/**
 * Register a fresh account and land in the app. Every run starts on an empty
 * database, so registration is part of the fixture rather than a test.
 * Onboarding (connecting Claude) is skipped — these tests deliberately avoid
 * the model so they are deterministic and cost no quota.
 */
export async function signUp(page: Page, email = `e2e${Date.now()}@test.local`) {
  await page.getByRole('link', { name: /create one/i }).click();
  // Labels are visual siblings, not bound via for/id (Chrome flags this), so
  // getByLabel does not resolve — select by field order/type instead.
  const inputs = page.locator('form input');
  await inputs.first().waitFor({ timeout: 30_000 });
  await inputs.nth(0).fill('E2E User'); // display name
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill('E2ePassw0rd!');
  await page.getByRole('button', { name: /create account/i }).click();

  await page.getByRole('button', { name: /skip for now/i }).click({ timeout: 30_000 });
  return email;
}

/** Create the first workspace and wait for the chat view. */
export async function createWorkspace(page: Page, name = 'E2E Workspace') {
  // Creation lives behind the workspace switcher, and the field commits on
  // Enter — there is no submit button.
  await page.getByRole('button', { name: /workspace/i }).first().click();
  await page.getByRole('button', { name: /new workspace/i }).click();
  const field = page.getByPlaceholder('Workspace name');
  await field.waitFor({ timeout: 30_000 });
  await field.fill(name);
  await field.press('Enter');
  await page.getByRole('heading', { name: /# general/ }).waitFor({ timeout: 60_000 });
}
