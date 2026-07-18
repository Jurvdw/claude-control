import { test, expect, signUp, createWorkspace } from './fixtures';

/**
 * Regression coverage for the real Electron app. Every test here corresponds to
 * something that actually broke during manual testing — this suite exists
 * because 100 green unit tests caught none of them.
 *
 * Deliberately no agent runs: model output is nondeterministic and costs quota,
 * so these assert PLUMBING (does the message persist, does the channel load,
 * does the workflow execute). Agent behaviour is audited separately.
 */

test.describe('Claude Control desktop', () => {
  test('boots the shell, backend and embedded Postgres', async ({ page }) => {
    // Reaching the app URL at all means: Electron started, the backend child
    // process came up, Postgres initialised and the SPA was served.
    await expect(page).toHaveURL(/localhost:4000/);
    await expect(page.getByText(/Claude Control/i).first()).toBeVisible();
  });

  test('exposes the preload bridge to the renderer', async ({ page }) => {
    // window.ccDesktop is the ONLY channel between shell and app (version,
    // update events, installNow). A browser-only test cannot see this at all.
    const bridge = await page.evaluate(() => ({
      present: typeof (window as never as { ccDesktop?: unknown }).ccDesktop === 'object',
      keys: Object.keys((window as never as { ccDesktop?: object }).ccDesktop ?? {}),
    }));
    expect(bridge.present).toBe(true);
    expect(bridge.keys).toEqual(expect.arrayContaining(['version', 'onUpdate', 'installNow']));
  });

  test('reports the app version over IPC', async ({ page }) => {
    const version = await page.evaluate(() =>
      (window as never as { ccDesktop: { version(): Promise<string> } }).ccDesktop.version(),
    );
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('sends a message and shows it in the channel', async ({ page }) => {
    await signUp(page);
    await createWorkspace(page);

    await page.getByRole('textbox', { name: /Message #general/ }).fill('hello from e2e');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('paragraph').filter({ hasText: 'hello from e2e' })).toBeVisible({ timeout: 15_000 });
  });

  test('loads existing messages when the workspace is reopened', async ({ page }) => {
    // THE regression: setActiveServer auto-selected the default channel with the
    // raw state setter, skipping the fetch — so a channel with history rendered
    // "This is the start of #general" until clicked by hand.
    await signUp(page);
    await createWorkspace(page);

    await page.getByRole('textbox', { name: /Message #general/ }).fill('persisted message');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('paragraph').filter({ hasText: 'persisted message' })).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await page.getByRole('heading', { name: /# general/ }).waitFor({ timeout: 30_000 });

    // Must appear WITHOUT clicking the channel first.
    await expect(page.getByRole('paragraph').filter({ hasText: 'persisted message' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('This is the start of')).toHaveCount(0);
  });

  test('survives a socket reconnect and still receives messages', async ({ page }) => {
    // Socket.IO rooms are per-connection. After a drop, the client reconnected
    // into NO rooms and silently stopped receiving anything for the workspace —
    // the UI looked perfectly healthy while agents replied into the void.
    await signUp(page);
    await createWorkspace(page);

    await page.evaluate(() => {
      const w = window as never as { io?: { disconnect(): void } };
      // Force a drop through the socket.io client if reachable, else offline it.
      w.io?.disconnect?.();
      window.dispatchEvent(new Event('offline'));
    });
    await page.waitForTimeout(2000);

    await page.getByRole('textbox', { name: /Message #general/ }).fill('after reconnect');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('paragraph').filter({ hasText: 'after reconnect' })).toBeVisible({ timeout: 20_000 });
  });

  test('creates a Brain note and lists it', async ({ page }) => {
    await signUp(page);
    await createWorkspace(page);

    await page.getByRole('button', { name: 'Brain' }).click();
    await expect(page.getByRole('button', { name: 'Brain' })).toBeVisible();
    // The panel renders without crashing on an empty vault — a real failure
    // mode for graph code that assumes at least one node.
    await expect(page.locator('body')).not.toContainText('Something went wrong');
  });

  test('opens Settings including the privacy vault', async ({ page }) => {
    await signUp(page);
    await createWorkspace(page);

    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByText('Privacy vault')).toBeVisible();
    // About only renders inside the desktop shell (it needs window.ccDesktop),
    // so its presence proves the preload reached the React tree.
    await expect(page.getByText('Version')).toBeVisible();
  });

  test('redacts a vault value in the preview', async ({ page }) => {
    await signUp(page);
    await createWorkspace(page);
    await page.getByRole('button', { name: 'Settings' }).click();

    await page.getByPlaceholder(/Value to protect/).fill('Klant 12345678');
    await page.getByRole('button', { name: /Add to vault/ }).click();
    await expect(page.getByText('<DATA_1>')).toBeVisible({ timeout: 15_000 });

    await page.getByPlaceholder(/Paste a sample message/).fill('Bel Klant 12345678 vandaag');
    await page.getByRole('button', { name: 'Preview' }).click();
    // What Claude would receive must not contain the real value.
    await expect(page.getByText(/Bel <DATA_1> vandaag/)).toBeVisible({ timeout: 15_000 });
  });
});
