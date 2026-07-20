# First-Run Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take a brand-new user from registration to a working first message with a guided understanding of the app's core features, without ever requiring them to leave the app or touch a terminal.

**Architecture:** Two independent pieces that compose at the end of onboarding. (1) Backend: the app already bundles the real `claude` CLI binary (for the Agent SDK); a new module spawns it to run `setup-token` and captures the printed token itself, so the existing manual copy-paste flow becomes optional rather than required. (2) Frontend: a new `TourContext` + `SpotlightTour` component drives a 7-step guided walkthrough of the real UI, triggered once per user (tracked by a new `User.onboardedAt` field) the moment a workspace exists — regardless of whether that workspace came from the new automated connect flow or the existing "Skip for now" + manual creation path.

**Tech Stack:** Express + Prisma + PostgreSQL (backend), React + TypeScript + Tailwind (frontend), vitest (backend unit tests), Playwright (desktop e2e).

## Global Constraints

- No new Prisma migration files — this codebase applies schema changes via idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `packages/server/src/db/embedded.ts`'s `ADDITIVE_SQL`, run on every boot (see Task 1). This is how `Run.tools` and `ServerWebhook.requireSignature` were added; follow the same pattern.
- No route-level (supertest-style) tests — this codebase's test suite is 100% pure-function/unit tests with mocked dependencies (see `packages/server/tests/*.test.ts`). New backend logic must be written as testable pure functions/modules; routes stay thin and are verified manually.
- Setup tokens are prefixed `sk-ant-oat` (per the existing UI placeholder `sk-ant-oat…` in `OnboardingPage.tsx`).
- The bundled Claude binary ships only for `win32-x64` today (`@anthropic-ai/claude-agent-sdk-win32-x64`) — this app is Windows-only. Fail clearly on any other platform rather than guessing a path.
- Agents only respond to `@mention` — never remove or weaken this in any UI copy; the tour teaches it, it doesn't change it.
- "One-time only" tour: no skip/relaunch entry point is being built (decided during design). Do not add a "take the tour again" affordance.

---

## Task 1: `onboardedAt` tracking — schema, additive SQL, and the completion endpoint

**Files:**
- Modify: `packages/server/prisma/schema.prisma` (`User` model, ~line 17)
- Modify: `packages/server/src/db/embedded.ts` (`ADDITIVE_SQL`, ends at line 282)
- Modify: `packages/server/src/routes/auth.ts`

**Interfaces:**
- Produces: `POST /auth/onboarding-complete` → `{ user: { id, email, displayName, avatarUrl, createdAt, onboardedAt } }`
- Produces: `GET /auth/me` now also returns `onboardedAt` on the user object.

- [ ] **Step 1: Add the field to the schema**

In `packages/server/prisma/schema.prisma`, in the `User` model:

```prisma
model User {
  id           String   @id @default(cuid())
  email        String   @unique
  passwordHash String
  displayName  String
  avatarUrl    String?
  onboardedAt  DateTime?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
```

(Only the `onboardedAt  DateTime?` line is new — insert it after `avatarUrl`.)

- [ ] **Step 2: Regenerate the Prisma client**

Run: `npm run db:generate -w @cc/server`
Expected: completes with no errors; `req.user!.onboardedAt` will now type-check as `Date | null` anywhere `req.user` is used.

- [ ] **Step 3: Add the additive SQL**

In `packages/server/src/db/embedded.ts`, add a line to the end of `ADDITIVE_SQL` (just before the closing `` ` `` on line 282):

```ts
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "onboardedAt" TIMESTAMP(3);
```

- [ ] **Step 4: Expose it on `/auth/me` and add the completion endpoint**

In `packages/server/src/routes/auth.ts`, change the `/me` handler's select to include the new field:

```ts
authRouter.get('/me', requireAuth, async (req, res) => {
  const user = req.user!;
  return res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      onboardedAt: user.onboardedAt,
      createdAt: user.createdAt,
    },
  });
});
```

Then add a new route right after it in the same file:

```ts
authRouter.post('/onboarding-complete', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { onboardedAt: new Date() },
      select: { id: true, email: true, displayName: true, avatarUrl: true, onboardedAt: true, createdAt: true },
    });
    return res.json({ user });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 5: Manually verify**

Run: `npm run dev` (or restart the dev server), then in a browser console on a logged-in session:
```js
fetch('/auth/onboarding-complete', { method: 'POST', credentials: 'include' }).then((r) => r.json()).then(console.log)
```
Expected: `{ user: { ..., onboardedAt: "2026-07-20T..." } }` — a real ISO timestamp, not `null`.

- [ ] **Step 6: Commit**

```bash
git add packages/server/prisma/schema.prisma packages/server/src/db/embedded.ts packages/server/src/routes/auth.ts
git commit -m "Add onboardedAt tracking for the first-run tour"
```

---

## Task 2: Resolve the bundled Claude binary and parse its setup-token output

**Files:**
- Create: `packages/server/src/llm/setupTokenFlow.ts`
- Test: `packages/server/tests/setupTokenFlow.test.ts`

**Interfaces:**
- Produces: `resolveClaudeBinary(): string` — absolute path to the bundled `claude.exe`.
- Produces: `parseSetupTokenOutput(stdout: string): string | null` — extracts a `sk-ant-oat...` token from CLI output, or `null`.
- Consumed by: Task 3 (session orchestration in the same file), Task 4 (routes).

- [ ] **Step 1: Write the failing tests**

Create `packages/server/tests/setupTokenFlow.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveClaudeBinary, parseSetupTokenOutput } from '../src/llm/setupTokenFlow.js';

describe('resolveClaudeBinary', () => {
  it('resolves the win32-x64 bundled binary path', () => {
    if (process.platform !== 'win32' || process.arch !== 'x64') return; // this app is Windows-only today
    const p = resolveClaudeBinary();
    expect(p.toLowerCase()).toMatch(/claude-agent-sdk-win32-x64.*claude\.exe$/i);
  });
});

describe('parseSetupTokenOutput', () => {
  it('extracts a token from surrounding CLI text', () => {
    const stdout = 'Signed in!\n\nYour token: sk-ant-oat01-abcDEF_123-xyz\n\nUse this to authenticate.';
    expect(parseSetupTokenOutput(stdout)).toBe('sk-ant-oat01-abcDEF_123-xyz');
  });

  it('returns null when no token is present', () => {
    expect(parseSetupTokenOutput('Sign-in cancelled.')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/setupTokenFlow.test.ts -w @cc/server`
Expected: FAIL — `Cannot find module '../src/llm/setupTokenFlow.js'`

- [ ] **Step 3: Implement the two pure functions**

Create `packages/server/src/llm/setupTokenFlow.ts`:

```ts
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Locate the Claude CLI binary bundled with the Agent SDK. The app already
 * ships this for @anthropic-ai/claude-agent-sdk to spawn during agent runs, so
 * asking the user to separately "install Claude Code" is unnecessary — this
 * resolves the exact same binary the SDK itself uses.
 *
 * Platform packages follow npm's optional-dependency convention:
 * @anthropic-ai/claude-agent-sdk-<platform>-<arch>. Only win32-x64 is shipped
 * today (the desktop app is Windows-only); fail clearly on anything else
 * rather than silently returning a wrong path.
 */
export function resolveClaudeBinary(): string {
  const platform = process.platform;
  const arch = process.arch;
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error(`No bundled Claude binary for ${platform}-${arch} (only win32-x64 is shipped).`);
  }
  const pkgName = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  const pkgJsonPath = require.resolve(`${pkgName}/package.json`);
  return path.join(path.dirname(pkgJsonPath), 'claude.exe');
}

/**
 * Extract a setup-token from `claude setup-token`'s stdout. Tokens are
 * sk-ant-oat-prefixed; the CLI prints explanatory text around it, so this
 * matches the token itself rather than anchoring to a specific line format.
 */
export function parseSetupTokenOutput(stdout: string): string | null {
  const match = stdout.match(/sk-ant-oat[A-Za-z0-9_-]+/);
  return match ? match[0] : null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/setupTokenFlow.test.ts -w @cc/server`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/llm/setupTokenFlow.ts packages/server/tests/setupTokenFlow.test.ts
git commit -m "Resolve the bundled Claude binary and parse setup-token output"
```

---

## Task 3: Setup-token session orchestration

**Files:**
- Modify: `packages/server/src/llm/index.ts` (add `persistSubscriptionToken`)
- Modify: `packages/server/src/llm/setupTokenFlow.ts` (add `startSetupToken`, `getSetupTokenStatus`, `cancelSetupToken`)
- Modify: `packages/server/tests/setupTokenFlow.test.ts`

**Interfaces:**
- Consumes: `resolveClaudeBinary`, `parseSetupTokenOutput` (Task 2, same file — no import needed, same module).
- Consumes: `validateSubscriptionToken(token?: string): Promise<{ ok: boolean; error?: string }>` (existing, `llm/index.ts`).
- Consumes: `encrypt(plaintext: string): string` (existing, `lib/crypto.ts`).
- Consumes: `prisma` (existing, `lib/prisma.ts`), `SUBSCRIPTION_LABEL` (existing, `llm/index.ts`).
- Produces: `persistSubscriptionToken(userId: string, token: string): Promise<{ apiKey: { id, label, last4, valid, createdAt } | null; valid: boolean; error?: string }>` — exported from `llm/index.ts`.
- Produces: `startSetupToken(userId: string, spawnFn?: SpawnFn): void`
- Produces: `getSetupTokenStatus(userId: string): { status: 'waiting' | 'success' | 'error'; error?: string } | null`
- Produces: `cancelSetupToken(userId: string): void`
- Consumed by: Task 4 (routes).

- [ ] **Step 1: Add the shared persistence helper**

In `packages/server/src/llm/index.ts`, add the `encrypt` import at the top:

```ts
import { encrypt } from '../lib/crypto.js';
```

Then add this function after `validateSubscriptionToken`:

```ts
/**
 * Validate and persist a real subscription token as this user's credential.
 * Shared by the manual-paste flow (routes/apiKeys.ts) and the in-app
 * setup-token flow (llm/setupTokenFlow.ts) so both save identically. Not used
 * for the ambient-login case (routes/apiKeys.ts keeps that inline — it has no
 * real token to validate/store the same way).
 */
export async function persistSubscriptionToken(
  userId: string,
  token: string,
): Promise<{ apiKey: { id: string; label: string; last4: string; valid: boolean; createdAt: Date } | null; valid: boolean; error?: string }> {
  const validation = await validateSubscriptionToken(token);
  const apiKey = await prisma.apiKey.create({
    data: {
      userId,
      label: SUBSCRIPTION_LABEL,
      ciphertext: encrypt(token),
      last4: token.slice(-4),
      valid: validation.ok,
    },
    select: { id: true, label: true, last4: true, valid: true, createdAt: true },
  });
  return { apiKey, valid: validation.ok, error: validation.error };
}
```

- [ ] **Step 2: Write the failing orchestration tests**

Append to `packages/server/tests/setupTokenFlow.test.ts` (add these imports at the top alongside the existing ones, and the `vi.mock` before the `describe` blocks):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  resolveClaudeBinary,
  parseSetupTokenOutput,
  startSetupToken,
  getSetupTokenStatus,
  cancelSetupToken,
} from '../src/llm/setupTokenFlow.js';

vi.mock('../src/llm/index.js', () => ({
  persistSubscriptionToken: vi.fn(async (_userId: string, token: string) =>
    token.includes('bad')
      ? { apiKey: null, valid: false, error: 'rejected' }
      : { apiKey: { id: '1', label: 'subscription', last4: 'good', valid: true, createdAt: new Date() }, valid: true, error: undefined },
  ),
}));

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  kill = vi.fn();
}
```

Then add this new `describe` block at the end of the file:

```ts
describe('setup-token session orchestration', () => {
  beforeEach(() => {
    cancelSetupToken('user-1'); // clear any session left by a previous test
  });

  it('reports waiting while the child is running', () => {
    const fake = new FakeChild();
    startSetupToken('user-1', () => fake as never);
    expect(getSetupTokenStatus('user-1')).toEqual({ status: 'waiting' });
  });

  it('reports success once the token is captured and persisted', async () => {
    const fake = new FakeChild();
    startSetupToken('user-1', () => fake as never);
    fake.stdout.emit('data', Buffer.from('token: sk-ant-oat01-good\n'));
    fake.emit('exit', 0);
    await new Promise((r) => setTimeout(r, 0)); // let persistSubscriptionToken's promise settle
    expect(getSetupTokenStatus('user-1')).toEqual({ status: 'success' });
  });

  it('reports an error when the process exits without a token', async () => {
    const fake = new FakeChild();
    startSetupToken('user-1', () => fake as never);
    fake.emit('exit', 1);
    await new Promise((r) => setTimeout(r, 0));
    expect(getSetupTokenStatus('user-1')?.status).toBe('error');
  });

  it('reports an error when the saved token is rejected', async () => {
    const fake = new FakeChild();
    startSetupToken('user-1', () => fake as never);
    fake.stdout.emit('data', Buffer.from('sk-ant-oat-bad\n'));
    fake.emit('exit', 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(getSetupTokenStatus('user-1')).toEqual({ status: 'error', error: 'rejected' });
  });

  it('cancel kills the child and clears the session', () => {
    const fake = new FakeChild();
    startSetupToken('user-1', () => fake as never);
    cancelSetupToken('user-1');
    expect(fake.kill).toHaveBeenCalled();
    expect(getSetupTokenStatus('user-1')).toBeNull();
  });

  it('starting a new flow cancels any in-flight one for the same user', () => {
    const first = new FakeChild();
    startSetupToken('user-1', () => first as never);
    const second = new FakeChild();
    startSetupToken('user-1', () => second as never);
    expect(first.kill).toHaveBeenCalled();
    expect(getSetupTokenStatus('user-1')).toEqual({ status: 'waiting' });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/setupTokenFlow.test.ts -w @cc/server`
Expected: FAIL — `startSetupToken is not a function` (and similar for `getSetupTokenStatus`/`cancelSetupToken`)

- [ ] **Step 4: Implement the orchestration**

Append to `packages/server/src/llm/setupTokenFlow.ts`:

```ts
import { spawn as realSpawn, type ChildProcess } from 'node:child_process';
import { persistSubscriptionToken } from './index.js';

export type SetupTokenStatus = 'waiting' | 'success' | 'error';

interface Session {
  status: SetupTokenStatus;
  error?: string;
  child: ChildProcess;
}

const sessions = new Map<string, Session>();

type SpawnFn = (command: string, args: readonly string[]) => ChildProcess;

/**
 * Start (or restart) the setup-token flow for a user. Spawns the bundled
 * `claude setup-token`, which opens the user's browser for Anthropic sign-in.
 * On success the token is captured from stdout and persisted immediately —
 * callers never see the raw token, only the resulting status.
 */
export function startSetupToken(userId: string, spawnFn: SpawnFn = realSpawn): void {
  cancelSetupToken(userId); // replace any in-flight session for this user

  const child = spawnFn(resolveClaudeBinary(), ['setup-token']);
  const session: Session = { status: 'waiting', child };
  sessions.set(userId, session);

  let stdout = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  child.on('error', (err) => {
    session.status = 'error';
    session.error = err.message;
  });

  child.on('exit', (code) => {
    if (session.status !== 'waiting') return; // already cancelled — see cancelSetupToken
    const token = parseSetupTokenOutput(stdout);
    if (code !== 0 || !token) {
      session.status = 'error';
      session.error =
        code !== 0
          ? 'Sign-in did not complete. Close the browser tab and try again, or paste a token manually.'
          : "Couldn't read the token from the sign-in flow. Paste it manually below.";
      return;
    }
    persistSubscriptionToken(userId, token)
      .then((result) => {
        if (result.valid) {
          session.status = 'success';
        } else {
          session.status = 'error';
          session.error = result.error ?? 'That token was rejected.';
        }
      })
      .catch((err) => {
        session.status = 'error';
        session.error = (err as Error).message;
      });
  });
}

/** Current status for a user's in-flight (or just-finished) setup-token flow. */
export function getSetupTokenStatus(userId: string): { status: SetupTokenStatus; error?: string } | null {
  const session = sessions.get(userId);
  if (!session) return null;
  return session.error ? { status: session.status, error: session.error } : { status: session.status };
}

/** Kill the in-flight child process, if any, and drop the session. */
export function cancelSetupToken(userId: string): void {
  const session = sessions.get(userId);
  if (session) {
    session.status = 'error'; // makes a late 'exit' handler on the old child a no-op
    session.child.kill();
    sessions.delete(userId);
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/setupTokenFlow.test.ts -w @cc/server`
Expected: PASS (9 tests total)

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/llm/index.ts packages/server/src/llm/setupTokenFlow.ts packages/server/tests/setupTokenFlow.test.ts
git commit -m "Add setup-token session orchestration (spawn, capture, persist)"
```

---

## Task 4: Wire the setup-token endpoints and refactor the shared save path

**Files:**
- Modify: `packages/server/src/routes/apiKeys.ts`

**Interfaces:**
- Consumes: `startSetupToken`, `getSetupTokenStatus`, `cancelSetupToken` (Task 3, `llm/setupTokenFlow.ts`).
- Consumes: `persistSubscriptionToken` (Task 3, `llm/index.ts`).
- Produces: `POST /api-keys/subscription/setup-token/start` → `202 { ok: true }`
- Produces: `GET /api-keys/subscription/setup-token/status` → `200 { status: 'idle' | 'waiting' | 'success' | 'error', error?: string }`
- Produces: `POST /api-keys/subscription/setup-token/cancel` → `200 { ok: true }`
- Consumed by: Task 6 (frontend `apiKeys` client).

- [ ] **Step 1: Add the imports**

In `packages/server/src/routes/apiKeys.ts`, extend the existing import from `'../llm/index.js'` and add a new one:

```ts
import {
  validateKey,
  validateSubscriptionToken,
  subscriptionAllowed,
  claudeLoginDetected,
  persistSubscriptionToken,
  SUBSCRIPTION_LABEL,
  AMBIENT_MARKER,
} from '../llm/index.js';
import { startSetupToken, getSetupTokenStatus, cancelSetupToken } from '../llm/setupTokenFlow.js';
```

- [ ] **Step 2: Refactor the real-subscription-token branch to use the shared helper**

Replace the existing `POST /` handler body in `packages/server/src/routes/apiKeys.ts` with:

```ts
apiKeysRouter.post('/', async (req, res, next) => {
  try {
    const body = createSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid body' });

    const isSubscription = body.data.kind === 'subscription';
    const ambient = isSubscription && body.data.useExistingLogin === true;
    const key = body.data.key ?? '';

    if (isSubscription && !subscriptionAllowed) {
      return res.status(403).json({ error: 'Subscription mode is only available in the self-hosted desktop app.' });
    }
    if (isSubscription && !ambient && !key) {
      return res.status(400).json({ error: 'A subscription token is required (or use your existing login).' });
    }
    if (!isSubscription && !key) {
      return res.status(400).json({ error: 'An API key is required.' });
    }

    // Real subscription tokens (manual paste here, or the in-app setup-token
    // flow below) share one persistence path — see llm/index.ts.
    if (isSubscription && !ambient) {
      const { apiKey, valid, error } = await persistSubscriptionToken(req.user!.id, key);
      return res.status(201).json({ key: apiKey, valid, error });
    }

    let validation: { ok: boolean; error?: string };
    let ciphertext: string;
    let last4: string;
    if (isSubscription) {
      // ambient login
      validation = await validateSubscriptionToken(undefined);
      ciphertext = encrypt(AMBIENT_MARKER);
      last4 = 'login';
    } else {
      validation = await validateKey(key);
      ciphertext = encrypt(key);
      last4 = key.slice(-4);
    }

    const apiKey = await prisma.apiKey.create({
      data: {
        userId: req.user!.id,
        label: isSubscription ? SUBSCRIPTION_LABEL : (body.data.label ?? 'Anthropic'),
        ciphertext,
        last4,
        valid: validation.ok,
      },
      select: { id: true, label: true, last4: true, valid: true, createdAt: true },
    });

    return res.status(201).json({ key: apiKey, valid: validation.ok, error: validation.error });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 3: Add the three new routes**

Add these after the existing `DELETE /:id` route, before `export const providerRouter = Router();`:

```ts
// ── In-app subscription setup-token flow ─────────────────────────────────────
// The app bundles the real Claude CLI binary (for the Agent SDK), so it can
// run `claude setup-token` itself instead of asking the user to open a
// terminal. The only thing that still leaves the app is the OAuth browser tab
// — unavoidable for sign-in, but not a terminal.

apiKeysRouter.post('/subscription/setup-token/start', (req, res) => {
  if (!subscriptionAllowed) {
    return res.status(403).json({ error: 'Subscription mode is only available in the self-hosted desktop app.' });
  }
  startSetupToken(req.user!.id);
  return res.status(202).json({ ok: true });
});

apiKeysRouter.get('/subscription/setup-token/status', (req, res) => {
  const status = getSetupTokenStatus(req.user!.id);
  return res.json(status ?? { status: 'idle' });
});

apiKeysRouter.post('/subscription/setup-token/cancel', (req, res) => {
  cancelSetupToken(req.user!.id);
  return res.json({ ok: true });
});
```

- [ ] **Step 4: Typecheck**

Run: `npm run build -w @cc/server`
Expected: compiles with no errors.

- [ ] **Step 5: Run the existing test suite to confirm nothing broke**

Run: `npm run test -w @cc/server`
Expected: all tests pass (the refactor in Step 2 must not change behavior for the ambient-login or API-key paths — there is no existing route-level test for `POST /api-keys`, so this is a regression check on everything else, not that route specifically).

- [ ] **Step 6: Manually verify the new routes' error paths**

Run the dev server (`npm run dev`), then from a logged-in browser console:
```js
await fetch('/api-keys/subscription/setup-token/status', { credentials: 'include' }).then((r) => r.json())
```
Expected: `{ status: 'idle' }` (no session started yet).
```js
await fetch('/api-keys/subscription/setup-token/cancel', { method: 'POST', credentials: 'include' }).then((r) => r.json())
```
Expected: `{ ok: true }` (cancel with nothing running is a safe no-op).

Do not manually test the `start` route's happy path here — it spawns the real binary and opens a real OAuth sign-in tab, which is a genuine credential action for whichever Anthropic account is signed into the browser. That path is covered by manual end-to-end testing once the frontend (Task 6) exists, run deliberately by a human.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/routes/apiKeys.ts
git commit -m "Wire the in-app setup-token endpoints onto the api-keys router"
```

---

## Task 5: Frontend types, API client, and auth context

**Files:**
- Modify: `packages/web/src/lib/types.ts`
- Modify: `packages/web/src/lib/api.ts`
- Modify: `packages/web/src/state/AuthContext.tsx`

**Interfaces:**
- Produces: `User.onboardedAt: string | null`
- Produces: `auth.completeOnboarding(): Promise<{ user: User }>`
- Produces: `apiKeys.startSetupToken(): Promise<{ ok: boolean }>`
- Produces: `apiKeys.setupTokenStatus(): Promise<{ status: 'idle' | 'waiting' | 'success' | 'error'; error?: string }>`
- Produces: `apiKeys.cancelSetupToken(): Promise<{ ok: boolean }>`
- Produces: `useAuth().completeOnboarding(): Promise<void>` — calls the endpoint and updates local `user` state.
- Consumed by: Task 6 (`OnboardingPage`), Task 7 (`TourContext`).

- [ ] **Step 1: Add the field to the `User` type**

In `packages/web/src/lib/types.ts`:

```ts
export interface User {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  onboardedAt: string | null;
}
```

- [ ] **Step 2: Extend the `auth` and `apiKeys` API namespaces**

In `packages/web/src/lib/api.ts`, replace the `auth` export with:

```ts
export const auth = {
  me: () => get<{ user: User }>('/auth/me'),
  login: (email: string, password: string) => post<{ user: User }>('/auth/login', { email, password }),
  register: (email: string, password: string, displayName: string) =>
    post<{ user: User }>('/auth/register', { email, password, displayName }),
  logout: () => post<{ ok: boolean }>('/auth/logout'),
  completeOnboarding: () => post<{ user: User }>('/auth/onboarding-complete'),
};
```

And replace the `apiKeys` export with:

```ts
export const apiKeys = {
  list: () => get<{ keys: ApiKey[] }>('/api-keys'),
  create: (label: string | undefined, key: string, kind: 'api' | 'subscription' = 'api') =>
    post<{ key: ApiKey; valid: boolean; error?: string }>('/api-keys', { label, key, kind }),
  // Connect the machine's existing Claude login (no token needed).
  connectExistingLogin: () =>
    post<{ key: ApiKey; valid: boolean; error?: string }>('/api-keys', { kind: 'subscription', useExistingLogin: true }),
  delete: (id: string) => del<{ ok: boolean }>(`/api-keys/${id}`),
  providerStatus: () => get<ProviderStatus>('/provider/status'),
  startSetupToken: () => post<{ ok: boolean }>('/api-keys/subscription/setup-token/start'),
  setupTokenStatus: () =>
    get<{ status: 'idle' | 'waiting' | 'success' | 'error'; error?: string }>('/api-keys/subscription/setup-token/status'),
  cancelSetupToken: () => post<{ ok: boolean }>('/api-keys/subscription/setup-token/cancel'),
};
```

- [ ] **Step 3: Add `completeOnboarding` to `AuthContext`**

In `packages/web/src/state/AuthContext.tsx`, add to the interface:

```ts
interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => Promise<void>;
  completeOnboarding: () => Promise<void>;
}
```

Add the implementation, right after `logout`:

```ts
  const completeOnboarding = async () => {
    const { user } = await authApi.completeOnboarding();
    setUser(user);
  };
```

And add it to the provider's context value:

```tsx
  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, completeOnboarding }}>
      {children}
    </AuthContext.Provider>
  );
```

- [ ] **Step 4: Typecheck**

Run: `npm run build -w @cc/web`
Expected: compiles with no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/types.ts packages/web/src/lib/api.ts packages/web/src/state/AuthContext.tsx
git commit -m "Add onboardedAt and setup-token client plumbing"
```

---

## Task 6: Rewrite the connect-Claude page

**Files:**
- Modify: `packages/web/src/pages/OnboardingPage.tsx`

**Interfaces:**
- Consumes: `apiKeys.startSetupToken`, `apiKeys.setupTokenStatus`, `apiKeys.cancelSetupToken` (Task 5).
- Consumes: `servers.create(name: string, description?: string): Promise<{ server: Server }>` (existing, `lib/api.ts`).
- Consumes: `useAuth()` (Task 5, for `user.displayName`).

- [ ] **Step 1: Replace the file**

Replace the full contents of `packages/web/src/pages/OnboardingPage.tsx` with:

```tsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { apiKeys as keysApi, servers as serversApi } from '../lib/api';
import { useAuth } from '../state/AuthContext';
import type { ProviderStatus } from '../lib/types';
import { Button, Input } from '../components/ui';

type Tab = 'apikey' | 'subscription';
type SetupState = 'idle' | 'starting' | 'waiting' | 'error';

export default function OnboardingPage() {
  const nav = useNavigate();
  const { user } = useAuth();
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [tab, setTab] = useState<Tab>('apikey');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [setupState, setSetupState] = useState<SetupState>('idle');
  const [setupError, setSetupError] = useState('');
  const [showManualPaste, setShowManualPaste] = useState(false);

  useEffect(() => {
    keysApi.providerStatus().then((s) => {
      setStatus(s);
      if (s.subscriptionAvailable) setTab('subscription'); // prefer subscription in the desktop app
    }).catch(() => {});
  }, []);

  // A workspace is auto-created the moment Claude is connected, by whichever
  // path got there — no separate "create your first workspace" step.
  const finishOnboarding = async () => {
    const { server } = await serversApi.create(`${user?.displayName ?? 'My'}'s Workspace`);
    nav(`/${server.id}`);
  };

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { valid, error: verr } = await keysApi.create(undefined, value.trim(), tab === 'subscription' ? 'subscription' : 'api');
      if (!valid) {
        setError(verr || 'That credential failed validation. Double-check it and try again.');
        return;
      }
      await finishOnboarding();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const connectExisting = async () => {
    setBusy(true);
    setError('');
    try {
      const { valid, error: verr } = await keysApi.connectExistingLogin();
      if (!valid) {
        setError(verr || "Couldn't use your Claude login. Try `claude login`, or paste a setup-token instead.");
        return;
      }
      await finishOnboarding();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startSetup = async () => {
    setSetupState('starting');
    setSetupError('');
    try {
      await keysApi.startSetupToken();
      setSetupState('waiting');
    } catch (err) {
      setSetupState('error');
      setSetupError((err as Error).message);
    }
  };

  const cancelSetup = async () => {
    await keysApi.cancelSetupToken().catch(() => {});
    setSetupState('idle');
  };

  // Poll while waiting for the user to finish signing in in their browser.
  useEffect(() => {
    if (setupState !== 'waiting') return;
    const interval = setInterval(async () => {
      try {
        const s = await keysApi.setupTokenStatus();
        if (s.status === 'success') {
          clearInterval(interval);
          await finishOnboarding();
        } else if (s.status === 'error') {
          clearInterval(interval);
          setSetupState('error');
          setSetupError(s.error || 'Sign-in failed. Try again, or paste a token manually.');
        }
        // 'waiting' / 'idle' → keep polling
      } catch {
        // transient network hiccup — keep polling rather than failing on one bad request
      }
    }, 1500);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupState]);

  const subAvailable = status?.subscriptionAvailable;
  const loginDetected = status?.claudeLoginDetected;

  return (
    <div className="h-full flex items-center justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-lg animate-fade-in py-8">
        <div className="text-center mb-6">
          <div className="text-clay text-2xl font-bold">Connect Claude</div>
          <p className="text-cream-400 mt-2 text-sm">Choose how your agents talk to Claude.</p>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 mb-4 bg-ink-800 p-1 rounded-xl">
          {subAvailable && (
            <TabButton active={tab === 'subscription'} onClick={() => { setTab('subscription'); setValue(''); setError(''); }}>
              Claude subscription
            </TabButton>
          )}
          <TabButton active={tab === 'apikey'} onClick={() => { setTab('apikey'); setValue(''); setError(''); }}>
            API key
          </TabButton>
        </div>

        <form onSubmit={connect} className="bg-ink-850 border border-ink-700 rounded-2xl p-6 flex flex-col gap-4">
          {tab === 'subscription' ? (
            <>
              {loginDetected && (
                <div className="bg-ink-800 border border-emerald-500/40 rounded-xl p-4 animate-fade-in">
                  <div className="flex items-center gap-2 text-emerald-300 text-sm font-medium">
                    <span className="w-2 h-2 rounded-full bg-emerald-400" /> You're signed in with Claude on this machine
                  </div>
                  <p className="text-xs text-cream-400 mt-1">Use your existing login — nothing to paste.</p>
                  <Button type="button" className="mt-3 w-full" onClick={connectExisting} disabled={busy}>
                    {busy ? 'Connecting…' : 'Use my Claude login'}
                  </Button>
                  <div className="text-center text-[11px] text-ink-500 mt-3">— or connect a different account below —</div>
                </div>
              )}

              <div className="text-sm text-cream-200 space-y-3">
                <p>Run agents on your <strong className="text-clay">Claude Pro / Max / Team / Enterprise</strong> plan — usage draws from your plan limits instead of pay-per-token.</p>

                {setupState === 'idle' && (
                  <Button type="button" className="w-full" onClick={startSetup}>Connect with Claude subscription</Button>
                )}
                {setupState === 'starting' && (
                  <Button type="button" className="w-full" disabled>Starting…</Button>
                )}
                {setupState === 'waiting' && (
                  <div className="bg-ink-800 border border-ink-700 rounded-xl p-4 flex flex-col items-center gap-2 text-center">
                    <div className="animate-pulse-dot text-clay text-sm font-medium">Waiting for you to sign in…</div>
                    <p className="text-xs text-cream-400">A browser tab just opened to Anthropic's sign-in page. Come back here once you've signed in.</p>
                    <Button type="button" variant="ghost" onClick={cancelSetup}>Cancel</Button>
                  </div>
                )}
                {setupState === 'error' && (
                  <div className="bg-red-950/40 border border-red-500/30 rounded-xl p-3 text-sm text-red-300">
                    {setupError}
                    <Button type="button" variant="ghost" className="mt-2 w-full" onClick={() => setSetupState('idle')}>Try again</Button>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => setShowManualPaste((v) => !v)}
                  className="text-xs text-ink-500 hover:text-cream-300 underline decoration-dotted"
                >
                  {showManualPaste ? 'Hide manual option' : 'Already have a token, or connecting from another machine?'}
                </button>
              </div>

              {showManualPaste && (
                <div className="border-t border-ink-700 pt-4 space-y-3">
                  <ol className="list-decimal list-inside text-cream-400 text-xs space-y-1 bg-ink-800 rounded-lg p-3">
                    <li>On any machine with Node.js: <code className="text-clay">npm i -g @anthropic-ai/claude-code</code></li>
                    <li>Run <code className="text-clay">claude setup-token</code> and sign in with your Claude account.</li>
                    <li>Copy the token it prints and paste it below.</li>
                  </ol>
                  <div>
                    <label className="text-xs text-cream-400 mb-1 block">Subscription token</label>
                    <Input type="password" placeholder="sk-ant-oat…" value={value} onChange={(e) => setValue(e.target.value)} />
                  </div>
                  <Button type="submit" disabled={busy || !value.trim()}>{busy ? 'Validating…' : 'Connect & validate'}</Button>
                </div>
              )}

              <p className="text-[11px] text-ink-500 leading-relaxed border-t border-ink-700 pt-3">
                ⚠️ For individual use of <em>your own</em> subscription on your own machine only. Never pool, proxy, or resell subscription access. Anthropic's policy on this has changed before and this mode may stop working.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-cream-200">Bring your own <strong>Anthropic API key</strong>. It's encrypted at rest (AES-256-GCM) and billed pay-per-token to your account.</p>
              <div>
                <label className="text-xs text-cream-400 mb-1 block">Anthropic API key</label>
                <Input type="password" placeholder="sk-ant-…" value={value} onChange={(e) => setValue(e.target.value)} required autoFocus />
                <p className="text-xs text-ink-500 mt-1">Get one at console.anthropic.com. We run a tiny validation call before saving.</p>
              </div>
            </>
          )}

          {error && <p className="text-red-400 text-sm">{error}</p>}
          {tab === 'apikey' && (
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>{busy ? 'Validating…' : 'Connect & validate'}</Button>
              <Button type="button" variant="ghost" onClick={() => nav('/')}>Skip for now</Button>
            </div>
          )}
          {tab === 'subscription' && !showManualPaste && (
            <Button type="button" variant="ghost" onClick={() => nav('/')}>Skip for now</Button>
          )}
        </form>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx('flex-1 py-2 rounded-lg text-sm font-medium transition-colors', active ? 'bg-clay text-white' : 'text-cream-300 hover:bg-ink-750')}
    >
      {children}
    </button>
  );
}
```

Note the "Skip for now" button moved: it's still always reachable, but is now conditionally placed so it doesn't sit awkwardly under the manual-paste form's own submit button when that section is expanded.

- [ ] **Step 2: Typecheck**

Run: `npm run build -w @cc/web`
Expected: compiles with no errors.

- [ ] **Step 3: Manually verify the unchanged paths still work**

Run the app (`npm run dev` at the repo root, or the packaged app), register a new account, and confirm:
- The API key tab still validates and connects as before.
- "Skip for now" still lands on the empty-workspace screen.
- On the subscription tab, the manual-paste disclosure expands/collapses and the old three-step instructions are still there (now behind the toggle).

Do not click "Connect with Claude subscription" during this check — save the full happy-path click-through for Task 8, once the tour (which fires immediately after a workspace is created) is also in place, so you only need to do the real OAuth sign-in once.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/pages/OnboardingPage.tsx
git commit -m "Connect Claude subscription without leaving the app"
```

---

## Task 7: Tour state and the spotlight overlay component

**Files:**
- Create: `packages/web/src/lib/tourSteps.ts`
- Create: `packages/web/src/state/TourContext.tsx`
- Create: `packages/web/src/components/SpotlightTour.tsx`

**Interfaces:**
- Consumes: `useAuth()` (Task 5, for `user.onboardedAt` and `completeOnboarding`).
- Consumes: `useServer()` (existing, for `activeServer`).
- Produces: `TourStep` type, `TOUR_STEPS: TourStep[]`.
- Produces: `TourProvider`, `useTour(): { active, step, isLastStep, prefillText, next, skip, advanceOnSend }`.
- Produces: `<SpotlightTour view={view} onChangeView={setView} />` component.
- Consumed by: Task 8 (`App.tsx`, `AppPage.tsx`, `Sidebar.tsx`, `MessageComposer.tsx`).

- [ ] **Step 1: Define the step content**

Create `packages/web/src/lib/tourSteps.ts`:

```ts
import type { View } from '../pages/AppPage';

export interface TourStep {
  id: string;
  view: View | null; // null = don't change the current view (welcome/closing cards)
  target: string | null; // data-tour selector value; null = centered, non-anchored card
  title: string;
  body: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    view: 'chat',
    target: null,
    title: 'Welcome to Claude Control',
    body: 'This is #general. Your Manager is already here and ready to work.',
  },
  {
    id: 'chat',
    view: 'chat',
    target: 'composer',
    title: 'Talk to your agents',
    body: "Agents only respond when @mentioned — that's how you talk to any of them, including your Manager. Try sending the message below, or hit Next to skip ahead.",
  },
  {
    id: 'brain',
    view: 'brain',
    target: 'nav-brain',
    title: 'The Brain',
    body: 'Shared long-term memory across all your agents: notes plus a privacy vault that keeps sensitive values out of what gets sent to the model.',
  },
  {
    id: 'tasks',
    view: 'tasks',
    target: 'nav-tasks',
    title: 'Tasks',
    body: 'How agents track and hand off work to each other.',
  },
  {
    id: 'workflows',
    view: 'workflows',
    target: 'nav-workflows',
    title: 'Workflows',
    body: 'Automation: a trigger, a sequence of steps, and an agent action at the end. Templates like "Daily digest" and "Research → Brain" are ready to copy.',
  },
  {
    id: 'triggers',
    view: 'triggers',
    target: 'nav-triggers',
    title: 'Triggers',
    body: "Workflows don't have to be run by hand — set them to fire on a schedule or a webhook here.",
  },
  {
    id: 'closing',
    view: null,
    target: null,
    title: "That's the core loop",
    body: 'Settings has your connected account, the privacy vault, and usage — explore anytime.',
  },
];
```

- [ ] **Step 2: Build the tour state provider**

Create `packages/web/src/state/TourContext.tsx`:

```tsx
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useAuth } from './AuthContext';
import { useServer } from './ServerContext';
import { TOUR_STEPS, type TourStep } from '../lib/tourSteps';

interface TourContextValue {
  active: boolean;
  step: TourStep | null;
  isLastStep: boolean;
  prefillText: string | null;
  next: () => void;
  skip: () => void;
  advanceOnSend: () => void;
}

const TourContext = createContext<TourContextValue | null>(null);

export function TourProvider({ children }: { children: React.ReactNode }) {
  const { user, completeOnboarding } = useAuth();
  const { activeServer } = useServer();
  const [active, setActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  // Guards against re-triggering after finish(): completeOnboarding() is async,
  // so user.onboardedAt can still read stale-null for a moment after the tour
  // ends. Without this, the trigger effect below would immediately restart it.
  const [started, setStarted] = useState(false);

  // One-time trigger: as soon as a workspace exists for a user who has never
  // completed (or skipped) the tour, start it. State-driven rather than
  // route-driven so it fires whether the workspace came from the automated
  // connect-Claude flow or from "Skip for now" + manual creation later.
  useEffect(() => {
    if (started) return;
    if (!user || user.onboardedAt) return;
    if (!activeServer) return;
    setActive(true);
    setStepIndex(0);
    setStarted(true);
  }, [user, activeServer, started]);

  const finish = useCallback(() => {
    setActive(false);
    completeOnboarding().catch(() => {}); // best-effort; harmless to retry on next launch
  }, [completeOnboarding]);

  const next = useCallback(() => {
    setStepIndex((i) => {
      if (i + 1 >= TOUR_STEPS.length) {
        finish();
        return i;
      }
      return i + 1;
    });
  }, [finish]);

  const skip = useCallback(() => finish(), [finish]);

  const advanceOnSend = useCallback(() => {
    if (active && TOUR_STEPS[stepIndex]?.id === 'chat') next();
  }, [active, stepIndex, next]);

  const step = active ? TOUR_STEPS[stepIndex] : null;
  const isLastStep = stepIndex === TOUR_STEPS.length - 1;
  const prefillText = step?.id === 'chat' ? '@Manager ' : null;

  return (
    <TourContext.Provider value={{ active, step, isLastStep, prefillText, next, skip, advanceOnSend }}>
      {children}
    </TourContext.Provider>
  );
}

export function useTour() {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error('useTour must be used within TourProvider');
  return ctx;
}
```

- [ ] **Step 3: Build the overlay**

Create `packages/web/src/components/SpotlightTour.tsx`:

```tsx
import { useEffect, useState, useRef } from 'react';
import { useTour } from '../state/TourContext';
import type { View } from '../pages/AppPage';
import { Button } from './ui';

interface Props {
  view: View;
  onChangeView: (v: View) => void;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export default function SpotlightTour({ view, onChangeView }: Props) {
  const { active, step, isLastStep, next, skip } = useTour();
  const [rect, setRect] = useState<Rect | null>(null);
  const raf = useRef<number>();

  // Switch to the step's view if it isn't already active.
  useEffect(() => {
    if (step?.view && step.view !== view) onChangeView(step.view);
  }, [step, view, onChangeView]);

  // Track the target element's position every frame (cheap: one bounding-rect
  // read; setRect only fires — and only re-renders — when it actually moves).
  useEffect(() => {
    if (!active || !step?.target) {
      setRect(null);
      return;
    }
    const measure = () => {
      const el = document.querySelector(`[data-tour="${step.target}"]`);
      if (el) {
        const r = el.getBoundingClientRect();
        setRect((prev) =>
          prev && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height
            ? prev
            : { top: r.top, left: r.left, width: r.width, height: r.height },
        );
      }
      raf.current = requestAnimationFrame(measure);
    };
    raf.current = requestAnimationFrame(measure);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [active, step]);

  if (!active || !step) return null;

  const PADDING = 8;
  const cutout = rect
    ? { top: rect.top - PADDING, left: rect.left - PADDING, width: rect.width + PADDING * 2, height: rect.height + PADDING * 2 }
    : null;

  // Card position: to the right of the cutout if there's room, else below it;
  // centered on screen when there is no target (welcome/closing steps).
  const cardStyle: React.CSSProperties = cutout
    ? cutout.left + cutout.width + 320 < window.innerWidth
      ? { top: cutout.top, left: cutout.left + cutout.width + 16 }
      : { top: cutout.top + cutout.height + 16, left: Math.max(16, cutout.left) }
    : { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-label="Product tour">
      <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ width: '100vw', height: '100vh' }}>
        <defs>
          <mask id="tour-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {cutout && <rect x={cutout.left} y={cutout.top} width={cutout.width} height={cutout.height} rx={10} fill="black" />}
          </mask>
        </defs>
        <rect x="0" y="0" width="100%" height="100%" fill="rgba(10,9,8,0.72)" mask="url(#tour-mask)" />
        {cutout && (
          <rect
            x={cutout.left} y={cutout.top} width={cutout.width} height={cutout.height} rx={10}
            fill="none" stroke="#d97757" strokeWidth={2}
          />
        )}
      </svg>

      <div className="absolute w-80 bg-ink-850 border border-ink-700 rounded-2xl p-5 shadow-2xl animate-fade-in" style={cardStyle}>
        <h3 className="text-cream-50 font-semibold text-base">{step.title}</h3>
        <p className="text-cream-300 text-sm mt-2 leading-relaxed">{step.body}</p>
        <div className="flex items-center justify-between mt-4">
          <button type="button" onClick={skip} className="text-xs text-ink-500 hover:text-cream-300">
            Skip tour
          </button>
          <Button type="button" onClick={next}>{isLastStep ? 'Finish' : 'Next'}</Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run build -w @cc/web`
Expected: compiles with no errors. (This step is not wired into the app yet — Task 8 does that — so nothing renders it yet; a clean compile is the deliverable here.)

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/tourSteps.ts packages/web/src/state/TourContext.tsx packages/web/src/components/SpotlightTour.tsx
git commit -m "Add the spotlight tour state and overlay component"
```

---

## Task 8: Wire the tour into the app

**Files:**
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/pages/AppPage.tsx`
- Modify: `packages/web/src/components/Sidebar.tsx`
- Modify: `packages/web/src/components/MessageComposer.tsx`

**Interfaces:**
- Consumes: `TourProvider`, `useTour`, `SpotlightTour` (Task 7).

- [ ] **Step 1: Wrap the authenticated app in `TourProvider`**

In `packages/web/src/App.tsx`, add the import:

```ts
import { TourProvider } from './state/TourContext';
```

And update the main route's element:

```tsx
      <Route
        path="/:serverId?/:channelId?"
        element={
          <RequireAuth>
            <ServerProvider>
              <TourProvider>
                <AppPage />
              </TourProvider>
            </ServerProvider>
          </RequireAuth>
        }
      />
```

- [ ] **Step 2: Render the overlay in `AppPage`**

In `packages/web/src/pages/AppPage.tsx`, add the import:

```ts
import SpotlightTour from '../components/SpotlightTour';
```

And render it alongside the other overlays near the end of the JSX:

```tsx
      {showAgentModal && <AgentCreateModal open onClose={() => setShowAgentModal(false)} />}
      {showApprovals && <ApprovalsTray onClose={() => setShowApprovals(false)} />}
      <SpotlightTour view={view} onChangeView={setView} />
      <UpdateWatcher />
      {search.open && <SearchModal initialQuery={search.q} onClose={() => setSearch({ open: false, q: '' })} onSelectChannel={onSelectChannel} onSelectView={setView} />}
```

- [ ] **Step 3: Add tour anchors to the sidebar nav**

In `packages/web/src/components/Sidebar.tsx`, replace the `NAV` array with:

```ts
const NAV: { key: View; label: string; icon: JSX.Element; tourId?: string }[] = [
  { key: 'chat', label: 'Chat', icon: <IconChat /> },
  { key: 'brain', label: 'Brain', icon: <IconBrain />, tourId: 'nav-brain' },
  { key: 'tasks', label: 'Tasks', icon: <IconTasks />, tourId: 'nav-tasks' },
  { key: 'workflows', label: 'Workflows', icon: <IconWorkflows />, tourId: 'nav-workflows' },
  { key: 'triggers', label: 'Triggers', icon: <IconTriggers />, tourId: 'nav-triggers' },
  { key: 'activity', label: 'Activity', icon: <IconActivity /> },
  { key: 'usage', label: 'Usage', icon: <IconUsage /> },
  { key: 'settings', label: 'Settings', icon: <IconSettings /> },
];
```

And in the `NAV.map(...)` render, add `data-tour={item.tourId}` to the `<button>`:

```tsx
            <button
              onClick={() => onSelectView(item.key)}
              data-tour={item.tourId}
              className={clsx(
                'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors',
                view === item.key ? 'bg-ink-750 text-cream-50 font-medium' : 'text-cream-300 hover:bg-ink-800 hover:text-cream-100',
              )}
            >
```

- [ ] **Step 4: Wire the composer for prefill and auto-advance**

In `packages/web/src/components/MessageComposer.tsx`, add the import:

```ts
import { useTour } from '../state/TourContext';
```

Inside the component, right after the existing `useServer()` destructure, add:

```ts
  const { prefillText, advanceOnSend } = useTour();
```

Add a `useEffect` that seeds the composer once when the tour reaches the chat step (place it near the component's other `useEffect`s):

```ts
  useEffect(() => {
    if (prefillText && text === '') setText(prefillText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillText]);
```

In `submit()`, call `advanceOnSend()` after a successful send:

```ts
  const submit = async () => {
    const value = text.trim();
    if ((!value && pending.length === 0) || sending) return;
    setSending(true);
    try {
      if (value.startsWith('/') && pending.length === 0) {
        const handled = await runSlash(value);
        if (handled) { setText(''); return; }
      }
      await sendPlain(value, pending.length ? pending.map((f) => f.id) : undefined);
      setText('');
      setPending([]);
      advanceOnSend();
    } catch (e) {
      addToast('Failed to send', (e as Error).message, 'error');
    } finally {
      setSending(false);
    }
  };
```

Add `data-tour="composer"` to the composer's outer bar:

```tsx
      <div className={clsx('flex items-end gap-2 bg-ink-800 border rounded-xl px-3 py-2 transition-colors', 'border-ink-700 focus-within:border-clay')} data-tour="composer">
```

- [ ] **Step 5: Typecheck**

Run: `npm run build -w @cc/web`
Expected: compiles with no errors.

- [ ] **Step 6: Manually verify the full flow**

Run the packaged app (or `npm run desktop`), register a brand-new account, and:
1. Click "Connect with Claude subscription" — confirm a browser tab opens for sign-in, and that once you complete it, the app itself shows "Waiting…" then advances automatically (no paste needed).
2. Confirm the tour launches immediately in the newly-created workspace.
3. Click through all 7 steps, confirming each one highlights the right real element and switches to the right panel (Brain, Tasks, Workflows, Triggers).
4. On the "Talk to your agents" step, confirm the composer is prefilled with `@Manager `, and that sending a message auto-advances the tour.
5. Finish the tour, then reload the app — confirm it does not reappear.
6. Separately, register a second account, click "Skip for now" instead, land in the empty-workspace screen, manually create a workspace via the sidebar — confirm the tour launches there too.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/App.tsx packages/web/src/pages/AppPage.tsx packages/web/src/components/Sidebar.tsx packages/web/src/components/MessageComposer.tsx
git commit -m "Wire the spotlight tour into the app shell, sidebar, and composer"
```

---

## Task 9: Update e2e fixtures and add a tour test

**Files:**
- Modify: `packages/desktop/e2e/fixtures.ts`
- Modify: `packages/desktop/e2e/app.spec.ts`

**Interfaces:**
- Consumes: `signUp(page: Page, email?: string): Promise<string>` (existing).
- Modifies: `createWorkspace(page: Page, name?: string): Promise<void>` → adds an optional third parameter.

- [ ] **Step 1: Make `createWorkspace` dismiss the tour by default**

In `packages/desktop/e2e/fixtures.ts`, replace the `createWorkspace` function with:

```ts
/** Create the first workspace and wait for the chat view. */
export async function createWorkspace(page: Page, name = 'E2E Workspace', opts: { dismissTour?: boolean } = {}) {
  // Creation lives behind the workspace switcher, and the field commits on
  // Enter — there is no submit button.
  await page.getByRole('button', { name: /workspace/i }).first().click();
  await page.getByRole('button', { name: /new workspace/i }).click();
  const field = page.getByPlaceholder('Workspace name');
  await field.waitFor({ timeout: 30_000 });
  await field.fill(name);
  await field.press('Enter');
  await page.getByRole('heading', { name: /# general/ }).waitFor({ timeout: 60_000 });

  // Creating a workspace triggers the first-run tour (see TourContext) for a
  // user who has never completed onboarding — every e2e user is exactly that.
  // Dismiss it by default so the rest of the suite sees the real app; the
  // dedicated tour test opts out via { dismissTour: false } to exercise it.
  if (opts.dismissTour !== false) {
    const skipTour = page.getByRole('button', { name: /skip tour/i });
    if (await skipTour.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await skipTour.click();
    }
  }
}
```

- [ ] **Step 2: Add the tour test**

In `packages/desktop/e2e/app.spec.ts`, add a new test (following the existing tests' style — same `test(...)` shape, importing `signUp`/`createWorkspace`/`expect` the way the existing tests already do):

```ts
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
```

- [ ] **Step 3: Run the full e2e suite**

Run: `npm run e2e -w @cc/desktop`
Expected: all existing tests still pass (workspace creation now silently dismisses the tour in every test that doesn't opt out), plus the new "walks through the first-run tour" test passes.

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/e2e/fixtures.ts packages/desktop/e2e/app.spec.ts
git commit -m "Update e2e fixtures for the tour; add a dedicated tour test"
```

---

## Explicitly out of scope (per the design spec)

- Relaunching/replaying the tour after first completion — no UI entry point is built for this.
- Tour stops for Activity, Usage, MCP servers, or Settings sub-panels.
- Any change to the ambient-login detection or its "Use my Claude login" flow.
- Any change to how agents are triggered — `@mention`-only stays exactly as it is.
