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
    await expect(page.locator('code', { hasText: 'DATA_1' }).first()).toBeVisible({ timeout: 15_000 });

    await page.getByPlaceholder(/Paste a sample message/).fill('Bel Klant 12345678 vandaag');
    await page.getByRole('button', { name: 'Preview' }).click();
    // What Claude would receive must not contain the real value.
    await expect(page.locator('main')).toContainText('Bel <DATA_1> vandaag', { timeout: 15_000 });
  });

  test('walks through the first-run tour', async ({ page }) => {
    await signUp(page);
    await createWorkspace(page, 'Tour Workspace', { dismissTour: false });

    // 7 steps: welcome, chat, brain, tasks, workflows, triggers, closing.
    for (let i = 0; i < 6; i++) {
      await page.getByRole('button', { name: /^next$/i }).click();
    }
    await page.getByRole('button', { name: /^finish$/i }).click();

    // onboardedAt must actually be persisted, not just inferred from the UI.
    const me = await page.evaluate(() => fetch('/auth/me', { credentials: 'include' }).then((r) => r.json()));
    expect(me.user.onboardedAt).not.toBeNull();

    // And the tour must not reappear after a reload.
    await page.reload();
    await page.getByRole('heading', { name: /# general/ }).waitFor({ timeout: 60_000 });
    await expect(page.getByText("That's the core loop")).toHaveCount(0);
  });

  test('runs a workflow end-to-end (manual trigger -> post message)', async ({ page }) => {
    // Regression for the workflow engine + run wiring — a 2026-07-23 live QA
    // pass exercised this manually (topo order, node execution, run-status
    // socket updates); this locks it into the permanent suite. No agent node
    // involved, so it stays deterministic.
    await signUp(page);
    await createWorkspace(page);

    const { serverId, channelId } = await page.evaluate(async () => {
      const { servers } = await fetch('/servers', { credentials: 'include' }).then((r) => r.json());
      const serverId = servers[0].id;
      const { channels } = await fetch(`/servers/${serverId}/channels`, { credentials: 'include' }).then((r) => r.json());
      return { serverId, channelId: channels[0].id };
    });

    await page.getByRole('button', { name: 'Workflows' }).click();
    await page.getByRole('button', { name: 'New workflow' }).click();
    // Creating a workflow seeds a lone trigger.manual node and auto-loads it.
    await page.getByRole('button', { name: '▶ Run' }).waitFor({ timeout: 15_000 });
    const workflowId = await page.evaluate((sid) => localStorage.getItem(`cc.wf.sel.${sid}`), serverId);
    expect(workflowId).toBeTruthy();

    // Wire trigger.manual -> channel.post via the same PATCH endpoint the
    // canvas's own Save button calls — avoids a flaky drag-to-connect on the
    // React Flow canvas while still exercising the real engine end to end.
    const marker = `workflow e2e ${Date.now()}`;
    await page.evaluate(
      async ({ serverId, workflowId, channelId, marker }) => {
        const graph = {
          nodes: [
            { id: 'trigger', type: 'trigger.manual', position: { x: 80, y: 160 }, data: {} },
            { id: 'post', type: 'channel.post', position: { x: 320, y: 160 }, data: { channelId, text: marker } },
          ],
          edges: [{ id: 'e1', source: 'trigger', target: 'post' }],
        };
        const res = await fetch(`/servers/${serverId}/workflows/${workflowId}`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ graph }),
        });
        if (!res.ok) throw new Error(`workflow PATCH failed: ${res.status}`);
      },
      { serverId, workflowId, channelId, marker },
    );

    // The Run button posts /run, which reads the graph fresh from the DB —
    // the panel's own in-memory nodes (still just the lone trigger) are never
    // re-saved because `dirty` was never set by the raw PATCH above.
    await page.getByRole('button', { name: '▶ Run' }).click();

    await page.getByRole('button', { name: 'Chat' }).click();
    await expect(page.getByRole('paragraph').filter({ hasText: marker })).toBeVisible({ timeout: 15_000 });
  });

  test('fires a webhook-triggered workflow and posts the result', async ({ page, request }) => {
    // Regression for the public webhook receiver -> workflow dispatch path
    // (HMAC/tunnel plumbing around it was covered in the same 2026-07-23 QA
    // pass but isn't re-verified here — this locks in the dispatch itself).
    await signUp(page);
    await createWorkspace(page);

    const { serverId, channelId, webhookUrl } = await page.evaluate(async () => {
      const { servers } = await fetch('/servers', { credentials: 'include' }).then((r) => r.json());
      const serverId = servers[0].id;
      const { channels } = await fetch(`/servers/${serverId}/channels`, { credentials: 'include' }).then((r) => r.json());
      const webhook = await fetch(`/servers/${serverId}/hooks/webhook`, { credentials: 'include' }).then((r) => r.json());
      return { serverId, channelId: channels[0].id, webhookUrl: webhook.url as string };
    });

    await page.getByRole('button', { name: 'Workflows' }).click();
    await page.getByRole('button', { name: 'New workflow' }).click();
    await page.getByRole('button', { name: '▶ Run' }).waitFor({ timeout: 15_000 });
    const workflowId = await page.evaluate((sid) => localStorage.getItem(`cc.wf.sel.${sid}`), serverId);
    expect(workflowId).toBeTruthy();

    const marker = `webhook e2e ${Date.now()}`;
    await page.evaluate(
      async ({ serverId, workflowId, channelId, marker }) => {
        const graph = {
          nodes: [
            { id: 'trigger', type: 'trigger.webhook', position: { x: 80, y: 160 }, data: { event: '' } },
            { id: 'post', type: 'channel.post', position: { x: 320, y: 160 }, data: { channelId, text: marker } },
          ],
          edges: [{ id: 'e1', source: 'trigger', target: 'post' }],
        };
        const res = await fetch(`/servers/${serverId}/workflows/${workflowId}`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ graph }),
        });
        if (!res.ok) throw new Error(`workflow PATCH failed: ${res.status}`);
      },
      { serverId, workflowId, channelId, marker },
    );

    // Hit the PUBLIC receiver directly — no session/cookies — the same way an
    // external caller would.
    const hookRes = await request.post(webhookUrl, { data: { hello: 'world' } });
    expect(hookRes.ok()).toBe(true);
    const hookJson = await hookRes.json();
    expect(hookJson.workflowsStarted).toBeGreaterThanOrEqual(1);

    await page.getByRole('button', { name: 'Chat' }).click();
    await expect(page.getByRole('paragraph').filter({ hasText: marker })).toBeVisible({ timeout: 15_000 });
  });

  test('virtualizes a long message list and stays pinned to the newest message', async ({ page }) => {
    // Regression for the react-virtuoso swap (2026-07-23): confirms the feed
    // still renders the newest message and stays scrolled to it after a
    // volume of messages that would previously all mount as DOM nodes at
    // once (and, pre-virtualization, would have been silently truncated by
    // the old MAX_RENDERED=200 cap — this volume is deliberately below 200
    // so a regression back to the old cap would NOT be caught by messages
    // going missing, only by a real virtualization check).
    await signUp(page);
    await createWorkspace(page);

    const { serverId, channelId } = await page.evaluate(async () => {
      const { servers } = await fetch('/servers', { credentials: 'include' }).then((r) => r.json());
      const serverId = servers[0].id;
      const { channels } = await fetch(`/servers/${serverId}/channels`, { credentials: 'include' }).then((r) => r.json());
      return { serverId, channelId: channels[0].id };
    });

    // Seed 30 messages directly via the API — fast and deterministic versus
    // typing+sending through the UI, and exercises the same endpoint the
    // Send button uses.
    const lastMarker = 'virtuoso e2e message 30';
    await page.evaluate(
      async ({ serverId, channelId, lastMarker }) => {
        // Stays under the 50-message page-size cliff in
        // GET /servers/:serverId/channels/:channelId/messages (that endpoint
        // returns the oldest N, not newest N, when unpaginated — a separate,
        // pre-existing bug, not this test's concern) so all 30 seeded
        // messages come back regardless of that bug.
        for (let i = 1; i <= 30; i++) {
          const content = i === 30 ? lastMarker : `virtuoso e2e message ${i}`;
          const res = await fetch(`/servers/${serverId}/channels/${channelId}/messages`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content }),
          });
          if (!res.ok) throw new Error(`message ${i} POST failed: ${res.status}`);
        }
      },
      { serverId, channelId, lastMarker },
    );

    await page.reload();
    await page.getByRole('heading', { name: /# general/ }).waitFor({ timeout: 60_000 });

    // The newest message must be visible without any manual scrolling —
    // proves initialTopMostItemIndex/followOutput land the view at the
    // bottom of a freshly loaded long list.
    await expect(page.getByRole('paragraph').filter({ hasText: lastMarker })).toBeVisible({ timeout: 15_000 });

    // The first seeded message must NOT be mounted — proves the list is
    // actually windowed, not just capped-then-fully-rendered.
    // Anchored to an exact match: Playwright's `hasText` does substring
    // matching, so an unanchored 'virtuoso e2e message 1' would also match
    // messages 10-19, silently asserting an 11-message range instead of
    // just message 1.
    await expect(page.getByRole('paragraph').filter({ hasText: /^virtuoso e2e message 1$/ })).toHaveCount(0);
  });

  test('sets a light theme via Settings and persists it across reload', async ({ page }) => {
    await signUp(page);
    await createWorkspace(page);

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Light' }).click();

    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme')))
      .toBe('light');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe('rgb(250, 247, 242)'); // --ink-850 in light mode, see index.css

    await page.reload();
    await page.getByRole('heading', { name: /# general/ }).waitFor({ timeout: 60_000 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme')))
      .toBe('light');
    const stored = await page.evaluate(() => localStorage.getItem('cc.theme'));
    expect(stored).toBe('light');
  });
});
