import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { prisma } from '../lib/prisma.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { env } from '../config/env.js';
import { AnthropicApiKeyProvider } from './anthropic.js';
import { SubscriptionProvider } from './subscription.js';
import { LLMAuthError, type LLMProvider } from './types.js';

export * from './types.js';
export { MODEL_IDS, EFFORT_MAP, PRICES, estimateCost } from './pricing.js';

// Subscription credentials are stored as an ApiKey row with this label.
export const SUBSCRIPTION_LABEL = 'subscription';
// Sentinel ciphertext meaning "use the machine's existing Claude login".
export const AMBIENT_MARKER = '__ambient__';

/** Whether subscription mode is permitted on this deployment (self-hosted only). */
export const subscriptionAllowed = env.SELF_HOSTED;

/** True if this machine already has a Claude login the Agent SDK can use. */
export function claudeLoginDetected(): boolean {
  const home = os.homedir();
  return (
    existsSync(path.join(home, '.claude', '.credentials.json')) ||
    existsSync(path.join(home, '.claude.json'))
  );
}

/**
 * Resolve the LLM backend for a given account. Credential-driven:
 *  - a connected Claude subscription (self-hosted only) → SubscriptionProvider
 *    (either a pasted setup-token, or the machine's ambient Claude login)
 *  - otherwise the user's BYOK Anthropic API key (or platform fallback key)
 */
export async function getProviderForUser(userId: string): Promise<LLMProvider> {
  if (subscriptionAllowed) {
    const sub = await prisma.apiKey.findFirst({
      where: { userId, label: SUBSCRIPTION_LABEL },
      orderBy: { createdAt: 'desc' },
    });
    if (sub) {
      const secret = decrypt(sub.ciphertext);
      return new SubscriptionProvider(secret === AMBIENT_MARKER ? undefined : secret);
    }
  }

  const key = await prisma.apiKey.findFirst({
    where: { userId, NOT: { label: SUBSCRIPTION_LABEL } },
    orderBy: { createdAt: 'desc' },
  });

  let apiKey: string | undefined;
  if (key) apiKey = decrypt(key.ciphertext);
  else if (env.ANTHROPIC_API_KEY) apiKey = env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new LLMAuthError('No Anthropic API key or Claude subscription connected. Complete onboarding.');
  }
  return new AnthropicApiKeyProvider(apiKey);
}

/** Validate a raw API key without persisting. */
export async function validateKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  return new AnthropicApiKeyProvider(apiKey).validate();
}

/**
 * Validate a subscription credential without persisting. Pass a setup-token, or
 * undefined/empty to validate the machine's ambient Claude login.
 */
export async function validateSubscriptionToken(token?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const t = token && token !== AMBIENT_MARKER ? token : undefined;
    return await new SubscriptionProvider(t).validate();
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

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
