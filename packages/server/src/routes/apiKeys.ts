import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { encrypt } from '../lib/crypto.js';
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
import { requireAuth } from '../auth/middleware.js';
import { env } from '../config/env.js';

export const apiKeysRouter = Router();

apiKeysRouter.use(requireAuth);

apiKeysRouter.get('/', async (req, res, next) => {
  try {
    const keys = await prisma.apiKey.findMany({
      where: { userId: req.user!.id },
      select: { id: true, label: true, last4: true, valid: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ keys });
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  label: z.string().optional(),
  key: z.string().optional(),
  // "api" (Anthropic API key) or "subscription" (Claude subscription).
  kind: z.enum(['api', 'subscription']).optional(),
  // Subscription only: use the machine's existing Claude login (no token needed).
  useExistingLogin: z.boolean().optional(),
});

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

apiKeysRouter.delete('/:id', async (req, res, next) => {
  try {
    const apiKey = await prisma.apiKey.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });
    if (!apiKey) return res.status(404).json({ error: 'not found' });

    await prisma.apiKey.delete({ where: { id: apiKey.id } });
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

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

// Provider status (no-auth required per contract — but we expose it authed for simplicity)
export const providerRouter = Router();

providerRouter.get('/status', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const hasSubscription = (await prisma.apiKey.count({ where: { userId, label: SUBSCRIPTION_LABEL } })) > 0;
    const hasKey = (await prisma.apiKey.count({ where: { userId, valid: true, NOT: { label: SUBSCRIPTION_LABEL } } })) > 0;
    return res.json({
      // Active mode: subscription wins when connected and allowed.
      mode: subscriptionAllowed && hasSubscription ? 'subscription' : 'apikey',
      selfHosted: env.SELF_HOSTED,
      subscriptionAvailable: subscriptionAllowed,
      claudeLoginDetected: subscriptionAllowed && claudeLoginDetected(),
      hasSubscription,
      hasKey,
    });
  } catch (err) {
    next(err);
  }
});
