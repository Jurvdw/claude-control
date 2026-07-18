# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: app.spec.ts >> Claude Control desktop >> redacts a vault value in the preview
- Location: e2e\app.spec.ts:110:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText('<DATA_1>')
Expected: visible
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 15000ms
  - waiting for getByText('<DATA_1>')

```

```yaml
- complementary:
  - button "E2E Workspace Workspace":
    - img
    - text: E2E Workspace Workspace
    - img
  - navigation:
    - button "Chat":
      - img
      - text: Chat
    - text: Channels
    - button "+"
    - button "# general"
    - button "Brain":
      - img
      - text: Brain
    - button "Tasks":
      - img
      - text: Tasks
    - button "Workflows":
      - img
      - text: Workflows
    - button "Triggers":
      - img
      - text: Triggers
    - button "Activity":
      - img
      - text: Activity
    - button "Usage":
      - img
      - text: Usage
    - button "Settings":
      - img
      - text: Settings
  - button "+ New agent"
  - text: E2 E2E User
  - button "Log out":
    - img
- main:
  - heading "Settings" [level=1]
  - button "Search (messages, notes, tasks…)":
    - img
  - button "Pause all"
  - button "Resume"
  - button "Approvals"
  - heading "Settings" [level=1]
  - heading "Claude connection" [level=2]
  - paragraph: How your agents talk to Claude.
  - text: Not connected self-hosted
  - button "Subscription"
  - button "API key"
  - text: You're signed in with Claude on this machine
  - paragraph: Use your existing login — nothing to paste.
  - button "Use my Claude login"
  - paragraph:
    - text: Run agents on your Claude Pro / Max / Team plan. Paste a token from
    - code: claude setup-token
    - text: .
  - textbox "sk-ant-oat…"
  - button "Connect & validate" [disabled]
  - heading "Automation" [level=2]
  - paragraph: How this workspace's agents behave.
  - text: Require approval for sensitive actions Agents queue risky tool calls for your sign-off instead of running them.
  - switch
  - text: Proactive by default New agents may act without being explicitly mentioned.
  - switch
  - text: Brain write policy Whether agents edit the Brain directly or propose changes for review.
  - combobox:
    - option "Propose (review before applying)"
    - option "Direct (write immediately)" [selected]
  - text: Mention hop limit Max chain length when agents @mention each other (prevents runaway loops).
  - button "−"
  - text: "4"
  - button "+"
  - text: Max concurrent runs How many agent runs execute at once.
  - button "−"
  - text: "5"
  - button "+"
  - heading "Email" [level=2]
  - paragraph: Connect a mailbox so agents can read, search, sort, and send email (e.g. auto-file your inbox every morning).
  - text: Provider Presets fill in the mail servers for you.
  - combobox:
    - option "Gmail" [selected]
    - option "Outlook"
    - option "Yahoo"
    - option "iCloud"
    - option "Zoho — personal (@zoho.com)"
    - option "Zoho — own domain (US)"
    - option "Zoho — personal (EU / zoho.eu)"
    - option "Zoho — own domain (EU)"
    - option "Custom (IMAP)"
  - textbox "you@example.com"
  - textbox "App password"
  - button "Connect & verify" [disabled]
  - paragraph: "Use an app password, not your login password. Gmail: turn on 2-Step Verification, then Google Account → Security → App passwords. Nothing is sent anywhere but your mail provider; the password is encrypted at rest."
  - heading "MCP servers" [level=2]
  - paragraph: Give agents new tools by connecting MCP servers — GitHub, Slack, files, databases, and more.
  - button "+ Add from catalog"
  - button "Add custom…"
  - paragraph:
    - text: Secrets are encrypted at rest. Servers marked “needs Node” run a local command via
    - code: npx
    - text: — install Node.js (nodejs.org) first if you don't have it. Use Test to check a connection.
  - heading "Webhooks & tunnel" [level=2]
  - paragraph: Let external services trigger workflows (via a Webhook trigger node) by POSTing to your URL.
  - text: Public tunnel Expose the local app so webhooks can reach it from outside this machine.
  - button "Start tunnel"
  - text: Webhook URL · local only
  - textbox: http://localhost:4000/webhooks/2BIB2rmTLMaWEgUmUAmNdxCbxpEj-ruf
  - button "⧉"
  - paragraph:
    - text: POST here to fire every enabled workflow with a Webhook trigger. Append
    - code: /your-event
    - text: to target a named event.
  - text: Require signed requests (HMAC) Reject calls without a valid X-CC-Signature header. Strongly recommended if the URL is public.
  - switch
  - heading "Backup & restore" [level=2]
  - paragraph: Export or restore this workspace's agents, Brain, workflows, and triggers.
  - button "Export backup"
  - text: Import backup…
  - paragraph: Import is additive (existing agents/notes are skipped by name). Reload after importing.
  - heading "Privacy vault" [level=2]
  - paragraph: Swap sensitive values for placeholders before anything is sent to Claude, and swap them back in replies and tool calls.
  - checkbox "Redact sensitive values before sending to Claude"
  - text: Redact sensitive values before sending to Claude
  - checkbox "Also auto-detect emails, phone numbers, IBANs and card numbers" [checked] [disabled]
  - text: Also auto-detect emails, phone numbers, IBANs and card numbers
  - textbox "Value to protect (e.g. a customer number)": Klant 12345678
  - textbox "Label (optional, for you)"
  - button "Add to vault"
  - paragraph: "Check what Claude would actually receive:"
  - textbox "Paste a sample message…"
  - button "Preview" [disabled]
  - paragraph: This removes what it can recognise — vault entries and well-formed identifiers. Sensitive text it has never been told about (a name in a paragraph, an address, case details) still reaches Claude. Treat it as a filter for known values, not a guarantee.
  - heading "About" [level=2]
  - paragraph: Claude Control checks for updates in the background and installs them when you close the app.
  - text: Version 0.1.0
```

# Test source

```ts
  17  |     await expect(page).toHaveURL(/localhost:4000/);
  18  |     await expect(page.getByText(/Claude Control/i).first()).toBeVisible();
  19  |   });
  20  | 
  21  |   test('exposes the preload bridge to the renderer', async ({ page }) => {
  22  |     // window.ccDesktop is the ONLY channel between shell and app (version,
  23  |     // update events, installNow). A browser-only test cannot see this at all.
  24  |     const bridge = await page.evaluate(() => ({
  25  |       present: typeof (window as never as { ccDesktop?: unknown }).ccDesktop === 'object',
  26  |       keys: Object.keys((window as never as { ccDesktop?: object }).ccDesktop ?? {}),
  27  |     }));
  28  |     expect(bridge.present).toBe(true);
  29  |     expect(bridge.keys).toEqual(expect.arrayContaining(['version', 'onUpdate', 'installNow']));
  30  |   });
  31  | 
  32  |   test('reports the app version over IPC', async ({ page }) => {
  33  |     const version = await page.evaluate(() =>
  34  |       (window as never as { ccDesktop: { version(): Promise<string> } }).ccDesktop.version(),
  35  |     );
  36  |     expect(version).toMatch(/^\d+\.\d+\.\d+/);
  37  |   });
  38  | 
  39  |   test('sends a message and shows it in the channel', async ({ page }) => {
  40  |     await signUp(page);
  41  |     await createWorkspace(page);
  42  | 
  43  |     await page.getByRole('textbox', { name: /Message #general/ }).fill('hello from e2e');
  44  |     await page.getByRole('button', { name: 'Send' }).click();
  45  |     await expect(page.getByRole('paragraph').filter({ hasText: 'hello from e2e' })).toBeVisible({ timeout: 15_000 });
  46  |   });
  47  | 
  48  |   test('loads existing messages when the workspace is reopened', async ({ page }) => {
  49  |     // THE regression: setActiveServer auto-selected the default channel with the
  50  |     // raw state setter, skipping the fetch — so a channel with history rendered
  51  |     // "This is the start of #general" until clicked by hand.
  52  |     await signUp(page);
  53  |     await createWorkspace(page);
  54  | 
  55  |     await page.getByRole('textbox', { name: /Message #general/ }).fill('persisted message');
  56  |     await page.getByRole('button', { name: 'Send' }).click();
  57  |     await expect(page.getByRole('paragraph').filter({ hasText: 'persisted message' })).toBeVisible({ timeout: 15_000 });
  58  | 
  59  |     await page.reload();
  60  |     await page.getByRole('heading', { name: /# general/ }).waitFor({ timeout: 30_000 });
  61  | 
  62  |     // Must appear WITHOUT clicking the channel first.
  63  |     await expect(page.getByRole('paragraph').filter({ hasText: 'persisted message' })).toBeVisible({ timeout: 15_000 });
  64  |     await expect(page.getByText('This is the start of')).toHaveCount(0);
  65  |   });
  66  | 
  67  |   test('survives a socket reconnect and still receives messages', async ({ page }) => {
  68  |     // Socket.IO rooms are per-connection. After a drop, the client reconnected
  69  |     // into NO rooms and silently stopped receiving anything for the workspace —
  70  |     // the UI looked perfectly healthy while agents replied into the void.
  71  |     await signUp(page);
  72  |     await createWorkspace(page);
  73  | 
  74  |     await page.evaluate(() => {
  75  |       const w = window as never as { io?: { disconnect(): void } };
  76  |       // Force a drop through the socket.io client if reachable, else offline it.
  77  |       w.io?.disconnect?.();
  78  |       window.dispatchEvent(new Event('offline'));
  79  |     });
  80  |     await page.waitForTimeout(2000);
  81  | 
  82  |     await page.getByRole('textbox', { name: /Message #general/ }).fill('after reconnect');
  83  |     await page.getByRole('button', { name: 'Send' }).click();
  84  |     await expect(page.getByRole('paragraph').filter({ hasText: 'after reconnect' })).toBeVisible({ timeout: 20_000 });
  85  |   });
  86  | 
  87  |   test('creates a Brain note and lists it', async ({ page }) => {
  88  |     await signUp(page);
  89  |     await createWorkspace(page);
  90  | 
  91  |     await page.getByRole('button', { name: 'Brain' }).click();
  92  |     await expect(page.getByRole('button', { name: 'Brain' })).toBeVisible();
  93  |     // The panel renders without crashing on an empty vault — a real failure
  94  |     // mode for graph code that assumes at least one node.
  95  |     await expect(page.locator('body')).not.toContainText('Something went wrong');
  96  |   });
  97  | 
  98  |   test('opens Settings including the privacy vault', async ({ page }) => {
  99  |     await signUp(page);
  100 |     await createWorkspace(page);
  101 | 
  102 |     await page.getByRole('button', { name: 'Settings' }).click();
  103 |     await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  104 |     await expect(page.getByText('Privacy vault')).toBeVisible();
  105 |     // About only renders inside the desktop shell (it needs window.ccDesktop),
  106 |     // so its presence proves the preload reached the React tree.
  107 |     await expect(page.getByText('Version')).toBeVisible();
  108 |   });
  109 | 
  110 |   test('redacts a vault value in the preview', async ({ page }) => {
  111 |     await signUp(page);
  112 |     await createWorkspace(page);
  113 |     await page.getByRole('button', { name: 'Settings' }).click();
  114 | 
  115 |     await page.getByPlaceholder(/Value to protect/).fill('Klant 12345678');
  116 |     await page.getByRole('button', { name: /Add to vault/ }).click();
> 117 |     await expect(page.getByText('<DATA_1>')).toBeVisible({ timeout: 15_000 });
      |                                              ^ Error: expect(locator).toBeVisible() failed
  118 | 
  119 |     await page.getByPlaceholder(/Paste a sample message/).fill('Bel Klant 12345678 vandaag');
  120 |     await page.getByRole('button', { name: 'Preview' }).click();
  121 |     // What Claude would receive must not contain the real value.
  122 |     await expect(page.getByText(/Bel <DATA_1> vandaag/)).toBeVisible({ timeout: 15_000 });
  123 |   });
  124 | });
  125 | 
```