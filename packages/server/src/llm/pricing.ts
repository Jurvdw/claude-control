import type { AgentModelClass, AgentEffort } from '@prisma/client';

// Map an agent's model class to a concrete Anthropic model id.
// (See claude-api reference: Opus 4.8 / Sonnet 4.6 / Haiku 4.5.)
export const MODEL_IDS: Record<AgentModelClass, string> = {
  HAIKU: 'claude-haiku-4-5',
  SONNET: 'claude-sonnet-4-6',
  OPUS: 'claude-opus-4-8',
};

// Effort → API effort level (output_config.effort) + a max_tokens ceiling.
export const EFFORT_MAP: Record<AgentEffort, { effort: 'low' | 'medium' | 'high'; maxTokens: number }> = {
  LOW: { effort: 'low', maxTokens: 4096 },
  MEDIUM: { effort: 'medium', maxTokens: 8192 },
  HIGH: { effort: 'high', maxTokens: 16000 },
};

// Editable price table — USD per 1,000,000 tokens.
// Keep in sync with Anthropic pricing; this is the single source for cost estimates.
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number; // ~0.1x input
  cacheWrite: number; // ~1.25x input (5m TTL)
}

export const PRICES: Record<string, ModelPrice> = {
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Estimate USD cost of a run from token usage and the model id. */
export function estimateCost(model: string, usage: TokenUsage): number {
  const p = PRICES[model];
  if (!p) return 0;
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.cacheWrite) /
    1_000_000
  );
}
